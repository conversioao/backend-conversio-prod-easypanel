const { Client } = require('pg'); 
const client = new Client({ connectionString: 'postgres://postgres:GSHCVcBgoA3Q5K4pnsqoU8eo@161.97.77.110:5432/conversioai' }); 

client.connect().then(async () => { 
  await client.query(`INSERT INTO landing_media (slot_id, media_url, media_type, description) VALUES ('wa_video_account', '/videos/wa_agent_account.mp4', 'video', 'WhatsApp Agent: Tutorial para criar conta') ON CONFLICT (slot_id) DO NOTHING`); 
  await client.query(`INSERT INTO landing_media (slot_id, media_url, media_type, description) VALUES ('wa_video_ads', '/videos/wa_agent_ads.mp4', 'video', 'WhatsApp Agent: Como gerar Anúncios') ON CONFLICT (slot_id) DO NOTHING`); 
  await client.query(`INSERT INTO landing_media (slot_id, media_url, media_type, description) VALUES ('wa_video_credits', '/videos/wa_agent_credits.mp4', 'video', 'WhatsApp Agent: Como carregar Kwanza') ON CONFLICT (slot_id) DO NOTHING`); 
  await client.query(`INSERT INTO landing_media (slot_id, media_url, media_type, description) VALUES ('wa_img_pricing', '/images/wa_agent_pricing.png', 'image', 'WhatsApp Agent: Tabela de Preços') ON CONFLICT (slot_id) DO NOTHING`); 
  await client.query(`INSERT INTO landing_media (slot_id, media_url, media_type, description) VALUES ('wa_img_support', '/images/wa_agent_support.png', 'image', 'WhatsApp Agent: Suporte Humanizado e Funcionalidades') ON CONFLICT (slot_id) DO NOTHING`); 
  console.log('WhatsApp Agent Slots inserted'); 
  client.end(); 
}).catch(e => console.error(e));
