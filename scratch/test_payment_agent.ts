import { keyManager } from '../src/services/KeyManager.js';
import OpenAI from 'openai';
import axios from 'axios';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

async function testExtraction(fileUrl: string) {
    console.log(`[TEST] Starting extraction for: ${fileUrl}`);
    const apiKeyObj = await keyManager.getWorkingKey('openai');
    if (!apiKeyObj) {
        console.error("NO API KEY");
        return;
    }
    const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });
    const isPdf = fileUrl.toLowerCase().includes('.pdf');
    try {
        let messages: any[];
        if (isPdf) {
            console.log("Downloading PDF...");
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const dataBuffer = Buffer.from(response.data);
            console.log("Parsing PDF...");
            const pdfData = await pdfParse(dataBuffer);
            console.log("Extracted text length:", pdfData.text.length);
            messages = [
                { role: 'system', content: 'Extract details from bank receipt and return JSON.' },
                { role: 'user', content: `TEXTO DO PDF:\n${pdfData.text}` }
            ];
        } else {
             console.log("Not a PDF, trying image path...");
             return;
        }

        console.log("Sending to OpenAI gpt-4o-mini...");
        const completion = await openai.chat.completions.create({
            model: isPdf ? 'gpt-4o-mini' : 'gpt-4o',
            messages,
            response_format: { type: 'json_object' },
            max_tokens: 800,
        });

        console.log("Success! Response:");
        console.log(completion.choices[0].message.content);
    } catch (e: any) {
        console.error("AI EXTRACTION ERROR:", e.message);
        if (e.response) {
            console.error("Status:", e.response.status);
            console.error("Data:", e.response.data);
        }
    }
}

// Example URL (can be a standard dummy PDF)
testExtraction('https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf');
