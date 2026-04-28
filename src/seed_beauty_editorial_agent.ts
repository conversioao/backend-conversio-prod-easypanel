import { query } from './db.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SEED: Beauty Editorial Agent (CV-07)
// Agente especializado em vídeos cosméticos de 8 segundos
// com personagens negros/morenos angolanos e edição editorial de revista
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SYSTEM_PROMPT = `You are CV-07 — BeautyEditorialAgent, a world-class beauty & cosmetics video director specialising in creating 8-second editorial-style product ads for the Angolan market.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MANDATORY CREATIVE DNA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHARACTERS:
• ALWAYS Black or dark/mixed-race Angolan people (African, Angolan — Portuguese of Angola).
• 3 to 4 different women from various ethnicities, including dark-skin Black women (pele negra retinta).
• Characters are confident, radiant, aspirational — reflecting Luanda's modern professional woman.

VISUAL STYLE:
• Warm Golden Palette: Entire color story in beige, gold, and illuminated skin tones. No dark/dirty shadows.
• Selective Focus (Macro): Extreme close-ups of product detail — the texture of the cream, the shine of the bottle, the oil drops. Communicates quality and luxury.
• Cinematic consistency: the SAME product appears with IDENTICAL visual attributes in every scene.

EDITING RHYTHM ("The Beat"):
• Fast Cuts: Each clip = 0.5 to 1.2 seconds maximum.
• Sync: Cuts happen on music beats OR when the voiceover says key terms.
• Invisible Transitions: Lateral camera slides that push one frame into the next.

AUDIO:
• Premium Voice: Female voiceover — clear, measured, decisive. Each word with authority.
• Background Music: Modern lo-fi / soft house beat — sets the rhythm, not noisy.
• Language: Português de Angola — aspirational tone.

TYPOGRAPHY:
• Minimalist white text, centred on screen, with a period at the end (e.g. "PRIME.", "PERFECT.", "PROTECT.").
• Magazine editorial aesthetic.

SPLIT SCREEN:
• At least one moment with 2–3 panels showing different faces simultaneously.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT 8-SECOND NARRATIVE STRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCENE 1 [00:00 – 00:02] — VISUAL HOOK
Main model's face in extreme close-up with product near her face. Golden skin, macro lens. Warm backlight creates halo. Fast lateral slide intro. Voiceover (PT Angola): sharp authoritative phrase. Text overlay: "[KEY_WORD]."

SCENE 2 [00:02 – 00:05] — TEXTURE DEMONSTRATION
Product texture showcase: cream from container, spreading on dark skin, oil drops in light, macro application shots. 3–4 fast cuts on beat. Voiceover (PT Angola): sensory description of what product does. Text: "[BENEFIT_WORD]."

SCENE 3 [00:05 – 00:08] — PROOF OF RESULT + PACKSHOT
Split-screen of 2–3 glowing Angolan faces (different skin tones). Final 1 second: all products packshot on warm surface. Voiceover (PT Angola): confident closing + CTA. Text: "[RESULT_WORD]."`;

const USER_TEMPLATE = `PRODUCT ANALYSIS:
\${analysis}

USER INSTRUCTION:
\${userPrompt}

FORMAT: \${aspectRatio}
SEED: \${seed}

Based on ALL of the above, generate the complete Veo 3 promotional video prompt for a BEAUTY EDITORIAL 8-second ad. Characters MUST be Black/dark-skin Angolan women. Product must be visually consistent across all 3 scenes. Make the prompt cinematically precise — camera movements, lighting temperature, macro lens specs, and audio cues should all be explicit.`;

const STRUCTURED_OUTPUT = `{
  "video_id": "07",
  "agente": "CV-07 — Beauty Editorial",
  "seed_usado": "\${seed}",
  "prompt_veo3": "[Full English Veo 3 prompt — single dense paragraph, minimum 300 words]",
  "copy_anuncio": {
    "headline": "[Angolan Portuguese — magazine-style headline, max 8 words]",
    "corpo": "[Angolan Portuguese — 2-3 sentences aspirational body copy]",
    "cta": "[Angolan Portuguese — direct CTA with action verb]",
    "versao_stories": "[Ultra-short version for stories — max 15 words]",
    "versao_whatsapp": "[WhatsApp-optimised version with emojis]"
  },
  "hashtags": {
    "principais": ["#Angola", "#Luanda", "#beleza"],
    "nicho": ["#SkinCare", "#GlowUp", "#MadeForAngola"],
    "trending_angola": ["#LuandaBeauty"]
  }
}`;

async function seedBeautyEditorialAgent() {
    try {
        console.log('🎬 Seeding Beauty Editorial Agent (CV-07)...');

        const coreId = 'beauty-editorial-video';

        // 1. Insert Model (Core)
        await query(`
            INSERT INTO models (name, type, category, style_id, description, is_active, credit_cost, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (style_id) DO UPDATE SET 
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                is_active = EXCLUDED.is_active,
                sort_order = EXCLUDED.sort_order;
        `, [
            'Beauty Editorial',
            'video',
            'core',
            'CV-07',
            'Vídeos cosméticos de 8 segundos com personagens negros angolanos, edição de ritmo editorial, paleta dourada e planos macro de textura do produto.',
            true,
            0,
            17
        ]);

        // 2. Insert Prompt Agent
        await query(`
            INSERT INTO prompt_agents (technical_id, name, category, description, system_prompt, user_prompt_template, model_id, params, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (technical_id) DO UPDATE SET
                name = EXCLUDED.name,
                category = EXCLUDED.category,
                description = EXCLUDED.description,
                system_prompt = EXCLUDED.system_prompt,
                user_prompt_template = EXCLUDED.user_prompt_template,
                params = EXCLUDED.params,
                is_active = EXCLUDED.is_active;
        `, [
            coreId,
            'Beauty Editorial Video',
            'video',
            'Agente especializado em vídeos cosméticos de 8s com edição de ritmo de revista para o mercado angolano.',
            SYSTEM_PROMPT,
            USER_TEMPLATE,
            'gpt-4o',
            JSON.stringify({ structured_output: STRUCTURED_OUTPUT }),
            true
        ]);

        console.log('✅ CV-07 Beauty Editorial Agent seeded successfully!');
        process.exit(0);
    } catch (err: any) {
        console.error('❌ Seed failed:', err.message);
        process.exit(1);
    }
}

seedBeautyEditorialAgent();
