import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import { verifyPaymentProof } from '../src/services/paymentVerificationAgent.js';

async function run() {
    try {
        console.log('Testing extraction for 3be43c45-ea35-4391-bde3-1511033caa6c');
        const result = await verifyPaymentProof('3be43c45-ea35-4391-bde3-1511033caa6c');
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error('Error running extract:', e);
    }
}
run();
