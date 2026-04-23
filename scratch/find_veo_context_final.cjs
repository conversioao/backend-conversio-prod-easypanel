const fs = require('fs');

// Try a few different filenames just in case
const files = [
    'Conversio.ai - Gerador de Anúncios UGC FINALL.json',
    'Conversio.ai - Gerador de Anúncios UGC TODOS MODELOS.json'
];

for (const filename of files) {
    if (fs.existsSync(filename)) {
        console.log(`--- Checking ${filename} ---`);
        const content = fs.readFileSync(filename, 'utf8');
        const search = 'veo';
        let index = 0;
        while ((index = content.indexOf(search, index)) !== -1) {
            console.log('--- Match Context ---');
            console.log(content.substring(index - 150, index + 450));
            index += search.length;
            if (index > content.length - 100) break;
        }
    }
}
