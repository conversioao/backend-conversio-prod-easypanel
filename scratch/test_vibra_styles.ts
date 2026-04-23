import { ImpactAdsProAgent } from '../src/pipeline/agents/image/ImpactAdsProAgent.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function testVibraStyles() {
    console.log('🧪 Testing VIBRA ANGOLA styles...');
    
    const styles = [
        'Vibra Gigante',
        'Vibra Pop Grid',
        'Vibra Gloss Editorial',
        'Vibra Tech Energy',
        'Vibra Premium Service'
    ];

    for (const style of styles) {
        console.log(`\n--- Testing Style: ${style} ---`);
        try {
            const result = await ImpactAdsProAgent.generate({
                analysis: 'A generic luxury body lotion in a white bottle with floral patterns.',
                userPrompt: 'Create a high-impact ad for social media.',
                style: style,
                useBrandColors: false,
                brandColors: null,
                includeText: true,
                seed: 12345
            });

            console.log('✅ Generation successful');
            console.log('Prompt Snippet:', result.prompt.substring(0, 150) + '...');
            
            // Basic validation
            if (result.prompt.toLowerCase().includes('single frame') || result.prompt.toLowerCase().includes('one central composition')) {
                console.log('✨ SINGLE FRAME rule confirmed.');
            } else {
                console.warn('⚠️ SINGLE FRAME rule missing in prompt.');
            }

            if (style === 'Vibra Gigante' && (result.prompt.toLowerCase().includes('oversized') || result.prompt.toLowerCase().includes('giant'))) {
                console.log('✨ OVERSZIED style confirmed.');
            }
        } catch (e: any) {
            console.error(`❌ Error testing style ${style}:`, e.message);
        }
    }
}

testVibraStyles();
