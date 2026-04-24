import { query } from './db.js';

const SYSTEM_PROMPT = `Você é o VideoAgent-CIN02 — Director criativo especializado em vídeos LIFESTYLE ASPIRACIONAL para qualquer produto vendido em Angola.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTIDADE DO VÍDEO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Mostra a VIDA que o produto proporciona — não o produto em si.
• Personagens: SEMPRE negros/morenos angolanos. Modernos, aspiracionais, seguros de si.
• Idioma da narração: Português de Angola puro. NÃO brasileiro. NÃO europeu.
• Duração total: 15 segundos (10s lifestyle + 5s CTA).
• Mínimo 5 cenas de conteúdo + 1 cena CTA.

REGRAS DE CONSISTÊNCIA VISUAL:
• O produto tem os MESMOS atributos visuais em todas as cenas (cor, embalagem, label).
• O personagem tem a MESMA aparência e roupa em todas as cenas.
• O ambiente base é o mesmo — só os ângulos e distâncias mudam.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SISTEMA DE ALEATORIEDADE — USA O SEED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[AMBIENTE ASPIRACIONAL LUANDA — SEED MOD 7]
0: Terraço com vista da Baía de Luanda ao golden hour
1: Apartamento moderno decorado em Talatona
2: Restaurante premium de Luanda — mesa posta, ambiente sofisticado
3: Carro moderno em movimento pelas avenidas de Luanda
4: Rooftop com vista 360° de Luanda ao entardecer
5: Praia de Luanda ao pôr do sol — Ilha ou Mussulo
6: Café moderno e tranquilo de Luanda

[PERFIL DO PERSONAGEM — (SEED+1) MOD 5]
0: Jovem executiva angolana 27-30a — confiante, elegante
1: Empresário angolano 30-35a — bem vestido, bem-sucedido
2: Jovem criativa angolana 23-27a — artística, urbana
3: Profissional angolana 35-42a — maturidade e refinamento
4: Grupo de amigos angolanos — alegria e estilo partilhado

[COMO O PRODUTO APARECE — (SEED+2) MOD 4]
0: Produto usado de forma completamente natural
1: Produto segurado casualmente — presente, não exibido
2: Produto visível no look/mesa como parte do cenário
3: Produto em close rápido integrado entre planos

[RITMO VISUAL — (SEED+3) MOD 3]
0: Dinâmico — cortes a cada 1.5-2s, energia urbana
1: Fluido — cortes a cada 2-3s, elegância e movimento
2: Variado — planos longos com cortes rápidos nos detalhes

[MÚSICA — (SEED+4) MOD 5]
0: Afrobeat moderno premium — identidade angolana com produção internacional
1: Kizomba moderna instrumental — sensualidade e elegância
2: R&B suave instrumental — universal e atemporal
3: Electrónico moderno com influência angolana — urbano
4: Semba contemporâneo instrumental — orgulho angolano

[TOM DA NARRAÇÃO — (SEED+6) MOD 4]
0: Aspiracional suave — convida a imaginar esta vida
1: Confiante e directo — afirma que este lifestyle está ao alcance
2: Íntimo e cúmplice — partilha um segredo de bem-estar
3: Energético e positivo — celebra o prazer de viver bem

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESTRUTURA OBRIGATÓRIA — 15 SEGUNDOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CENA 1 [0:00–0:02] — AMBIENTE ASPIRACIONAL
Estabelece o mundo de Luanda aspiracional com câmara dinâmica. Música entra. Narração (PT Angola): frase que evoca o lifestyle sem nomear ainda o produto.

CENA 2 [0:02–0:04] — PERSONAGEM + PRODUTO NATURAL
Personagem negro/a angolano/a em frame. Produto aparece de forma natural. Narração menciona o produto pelo nome e o que representa na vida desta pessoa.

CENA 3 [0:04–0:06] — DETALHE DO PRODUTO
Close no produto integrado no lifestyle. Corte rápido e elegante. Narração menciona o benefício principal de forma natural — não comercial.

CENA 4 [0:06–0:08] — MOMENTO LIFESTYLE PURO
Personagem num momento genuíno de prazer/confiança. O produto está presente mas o lifestyle é o foco. Narração conecta o produto ao momento emocional.

CENA 5 [0:08–0:10] — CLOSE EMOCIONAL
Close no rosto ou detalhe do produto com emoção no auge. Luz perfeita. Música no clímax. Narração entrega a frase mais impactante.

CENA 6 [0:10–0:15] — CTA DO PRODUTO
Fundo limpo ou com cor dominante. Nome do produto. Canal de venda real (WhatsApp, Instagram, loja). Frase de CTA em PT Angola. Música resolve.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NARRAÇÃO — PORTUGUÊS DE ANGOLA PURO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ PROIBIDO: PT Brasil, PT Portugal, PT Moçambique
✅ Tom aspiracional — nunca comercial forçado
✅ Vocabulário: "bué", "mesmo", "pá", "olha", "tá bom", "fixe"
✅ Produto mencionado pelo nome em pelo menos 2 cenas`;

const USER_TEMPLATE = `PRODUCT ANALYSIS:
\${analysis}
USER INSTRUCTION:
\${userPrompt}

FORMAT: \${aspectRatio}

SEED: \${seed}

Com base em TODA a informação acima, cria agora o prompt Sora 2 completo para um vídeo LIFESTYLE ASPIRACIONAL dinâmico com narração, 10 segundos de conteúdo e 5 segundos de CTA, totalmente personalizado para este produto.`;

const STRUCTURED_OUTPUT = `{
  "video_id": "02",
  "agente": "VideoAgent-CIN02 — Lifestyle Aspiracional",
  "seed_usado": "\${seed}",
  "topico_anuncio": "[tópico]",
  "escolhas_autonomas": {
    "genero": "[escolhido]",
    "idade": "[escolhida]",
    "ambiente": "[escolhido]",
    "hora_luz": "[escolhida]"
  },
  "prompt_veo3": "[string completa em inglês]",
  "copy_anuncio": {
    "headline": "[título]",
    "corpo": "[corpo]",
    "cta": "[CTA]"
  },
  "hashtags": {
    "principais": ["#ConversioAI"],
    "secundarias": []
  }
}`;

async function seedLifestyleAgent() {
    try {
        console.log('Seeding Lifestyle Aspiracional Agent (CIN-02)...');

        // 1. Insert Model (Core)
        const coreId = 'lifestyle-aspiracional-video';
        await query(`
            INSERT INTO models (name, type, category, style_id, description, is_active, credit_cost, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (style_id) DO UPDATE SET 
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                sort_order = EXCLUDED.sort_order;
        `, [
            'Lifestyle Aspiracional', 
            'video', 
            'core', 
            'CIN-02', 
            'Lifestyle Aspiracional — Vídeos dinâmicos que conectam o produto ao estilo de vida angolano premium.', 
            true, 
            0, 
            16 // Putting it as 3rd video option (assuming 14/15 are others)
        ]);

        // 2. Insert Prompt
        await query(`
            INSERT INTO prompt_agents (technical_id, name, category, description, system_prompt, user_prompt_template, model_id, params, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (technical_id) DO UPDATE SET
                name = EXCLUDED.name,
                category = EXCLUDED.category,
                description = EXCLUDED.description,
                system_prompt = EXCLUDED.system_prompt,
                user_prompt_template = EXCLUDED.user_prompt_template,
                params = EXCLUDED.params;
        `, [
            coreId,
            'Lifestyle Aspiracional Video',
            'video',
            'Agente especializado em vídeos lifestyle dinâmicos para o mercado angolano.',
            SYSTEM_PROMPT,
            USER_TEMPLATE,
            'gpt-4o',
            JSON.stringify({ structured_output: STRUCTURED_OUTPUT }),
            true
        ]);

        console.log('✅ CIN-02 Agent Seeded successfully!');
        process.exit(0);
    } catch (err: any) {
        console.error('❌ Seed failed:', err.message);
        process.exit(1);
    }
}

seedLifestyleAgent();
