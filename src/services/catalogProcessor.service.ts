import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import { parse } from 'csv-parse/sync';
import { query } from '../db.js';
import { getAnthropicKey } from '../config.js';

export interface Product {
    name: string;
    price: number | null;
    quantity: number | null;
    category: string | null;
    description: string | null;
    unit: string | null;
}

export class CatalogProcessor {
    /**
     * Processa um ficheiro de catálogo e extrai os produtos
     */
    static async process(file: Express.Multer.File, userId: string, agentConfigId: number) {
        const extension = path.extname(file.originalname).toLowerCase();
        let rawContent = '';
        let products: Product[] = [];

        try {
            if (extension === '.pdf') {
                const dataBuffer = file.buffer || fs.readFileSync(file.path);
                const parser = new PDFParse({ data: dataBuffer });
                const data = await parser.getText();
                rawContent = data.text;
                products = await this.extractWithClaude(rawContent);
            } else if (extension === '.xlsx' || extension === '.xls') {
                const workbook = file.buffer ? XLSX.read(file.buffer) : XLSX.readFile(file.path);
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const data = XLSX.utils.sheet_to_json(worksheet);
                products = this.mapJsonToProducts(data);
            } else if (extension === '.csv') {
                const fileContent = file.buffer ? file.buffer.toString('utf-8') : fs.readFileSync(file.path, 'utf-8');
                const data = parse(fileContent, { columns: true, skip_empty_lines: true });
                products = this.mapJsonToProducts(data);
            } else {
                throw new Error('Formato de ficheiro não suportado. Use PDF, Excel ou CSV.');
            }

            // Guardar no banco de dados
            await query(`
                INSERT INTO agent_catalogs (user_id, agent_config_id, file_name, file_url, processed_data, uploaded_at, last_updated)
                VALUES ($1, $2, $3, $4, $5, now(), now())
            `, [userId, agentConfigId, file.originalname, file.path, JSON.stringify(products)]);

            return {
                success: true,
                total: products.length,
                preview: products.slice(0, 10)
            };

        } catch (err: any) {
            console.error('[CatalogProcessor] Error:', err.message);
            throw err;
        }
    }

    /**
     * Usa a API do Claude para extrair produtos de texto não estruturado (PDF)
     */
    private static async extractWithClaude(text: string): Promise<Product[]> {
        const anthropicKey = await getAnthropicKey();
        if (!anthropicKey) {
            console.warn('[CatalogProcessor] No Anthropic key found, fallback to basic extraction');
            return [];
        }

        const prompt = `
Recebes o conteúdo de um catálogo de produtos/serviços. 
Extrai TODOS os produtos/serviços e retorna APENAS um JSON válido.

### REGRAS:
1. Retorna um objeto com a chave "products" contendo um array de objetos.
2. Cada objeto deve ter: "name", "price", "quantity", "category", "description", "unit".
3. Se um campo não existir, usa null. 
4. O campo "price" deve ser um número (float) sem símbolos de moeda.
5. Se o texto for muito longo, foca-te nos itens principais.

### TEXTO DO CATÁLOGO:
${text.substring(0, 15000)} // Limit to avoid token limits
`;

        try {
            const response = await axios.post(
                'https://api.anthropic.com/v1/messages',
                {
                    model: 'claude-3-haiku-20240307',
                    max_tokens: 4096,
                    messages: [
                        { role: 'user', content: prompt }
                    ],
                    system: "És um assistente especializado em extração de dados estruturados. Responde apenas com JSON puro, sem explicações."
                },
                {
                    headers: {
                        'x-api-key': anthropicKey.key_secret,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json'
                    }
                }
            );

            const content = response.data.content[0]?.text;
            if (!content) return [];

            const parsed = JSON.parse(content);
            return parsed.products || [];

        } catch (err: any) {
            console.error('[CatalogProcessor] Claude API error:', err.response?.data || err.message);
            return [];
        }
    }

    /**
     * Mapeia JSON genérico (Excel/CSV) para o formato de Produto
     */
    private static mapJsonToProducts(data: any[]): Product[] {
        return data.map(item => ({
            name: item.name || item.Nome || item.Produto || item.item || 'Produto sem nome',
            price: this.parsePrice(item.price || item.Preço || item.Valor || item.cost),
            quantity: parseInt(item.quantity || item.Quantidade || item.Stock || item.estoque) || null,
            category: item.category || item.Categoria || item.Grupo || null,
            description: item.description || item.Descrição || item.Detalhes || null,
            unit: item.unit || item.Unidade || item.Medida || null
        }));
    }

    private static parsePrice(val: any): number | null {
        if (typeof val === 'number') return val;
        if (!val) return null;
        const cleaned = String(val).replace(/[^0-9.,]/g, '').replace(',', '.');
        return parseFloat(cleaned) || null;
    }
}
