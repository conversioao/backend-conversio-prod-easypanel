const axios = require('axios');

async function testStats() {
    try {
        // Since I don't have a token, I might get 401. 
        // But I want to see if the route is registered.
        const res = await axios.get('http://localhost:3003/api/admin/kie/stats');
        console.log('Response:', res.data);
    } catch (err) {
        console.log('Error status:', err.response?.status);
        console.log('Error message:', err.response?.data?.message);
    }
}

testStats();
