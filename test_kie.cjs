const axios = require('axios');
require('dotenv').config();

const KEY = '178b44adfc95ff2a46a6fd4b60092c7a';
const BASE = 'https://api.kie.ai/api/v1';

// Seedream 4.5 and 5 return 500 with correct ID - the issue is the field 'This field is required'
// Let's probe exactly which fields are needed
const tests = [
  // Seedream 4.5-edit: What fields does it need?
  {
    lbl: 'seedream/4.5-edit - with image_urls',
    payload: { model: 'seedream/4.5-edit', input: { prompt: 'test image', aspect_ratio: '1:1', image_urls: [] }}
  },
  {
    lbl: 'seedream/4.5-edit - with image_list',
    payload: { model: 'seedream/4.5-edit', input: { prompt: 'test image', aspect_ratio: '1:1', image_list: [] }}
  },
  {
    lbl: 'seedream/4.5-edit - no images at all',
    payload: { model: 'seedream/4.5-edit', input: { prompt: 'test image', aspect_ratio: '1:1' }}
  },
  {
    lbl: 'seedream/5-lite-text-to-image - with image_urls',
    payload: { model: 'seedream/5-lite-text-to-image', input: { prompt: 'test image', aspect_ratio: '1:1', image_urls: [] }}
  },
  {
    lbl: 'seedream/5-lite-text-to-image - with image_size',
    payload: { model: 'seedream/5-lite-text-to-image', input: { prompt: 'test image', image_size: '1:1' }}
  },
  {
    lbl: 'seedream/5-lite-text-to-image - no images',
    payload: { model: 'seedream/5-lite-text-to-image', input: { prompt: 'test image' }}
  },
];

async function run() {
  for (const t of tests) {
    try {
      const r = await axios.post(`${BASE}/jobs/createTask`, t.payload, {
        headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000
      });
      console.log(`[${t.lbl}] code=${r.data?.code} taskId=${r.data?.data?.taskId} msg=${r.data?.msg}`);
    } catch(e) {
      console.log(`[${t.lbl}] HTTP ${e.response?.status}: code=${e.response?.data?.code} msg=${e.response?.data?.msg || e.response?.data?.message}`);
    }
  }
}

run();
