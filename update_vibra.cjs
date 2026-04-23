const { Client } = require('pg'); 
const client = new Client({ connectionString: 'postgres://postgres:GSHCVcBgoA3Q5K4pnsqoU8eo@161.97.77.110:5432/conversioai' }); 

client.connect().then(async () => { 
  await client.query(`UPDATE prompt_agents SET name = 'VIBRA PREMIUM' WHERE technical_id = 'lifestyle-aspiracional-video'`); 
  console.log('prompt_agents updated'); 
  client.end(); 
}).catch(e => console.error(e));
