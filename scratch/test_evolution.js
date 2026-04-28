const axios = require('axios');
const url = 'https://conversioai-evolution.odbegs.easypanel.host/instance/connectionState/Conversio-Oficial';
const apikey = 'F72D1BD24B64-48E3-8E08-3FA3F6BFC522';

axios.get(url, { headers: { apikey } })
    .then(res => {
        console.log('API Response:', JSON.stringify(res.data, null, 2));
    })
    .catch(err => {
        console.error('API Error:', err.response?.data || err.message);
    });
