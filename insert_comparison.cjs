const { Client } = require('pg'); 
const client = new Client({ connectionString: 'postgres://postgres:GSHCVcBgoA3Q5K4pnsqoU8eo@161.97.77.110:5432/conversioai' }); 

client.connect().then(async () => { 
  await client.query(`INSERT INTO landing_media (slot_id, media_url, media_type, description) VALUES ('comparison_video', '/videos/comparacao.mp4', 'video', 'Vídeo de Fundo da Secção de Comparação') ON CONFLICT (slot_id) DO NOTHING`); 
  console.log('Slots inserted'); 
  client.end(); 
}).catch(e => console.error(e));
