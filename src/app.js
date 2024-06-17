const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
const fetch = require('cross-fetch');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
require('dotenv').config();

const agent = new https.Agent({ rejectUnauthorized: false });

const requiredEnvVars = ['RPC_URL', 'PRIVATE_KEY_SOLFLAIRE', 'JUPITER_URL_QUOTE', 'JUPITER_URL_SWAP', 'INPUT_MINT', 'OUTPUT_MINT', 'AMOUNT_SOL', 'SLIPPAGE', 'PORT'];

requiredEnvVars.forEach((varName) => {
    if (!process.env[varName]) {
        throw new Error(`${varName} environment variable is not set`);
    }
});

const connection = new Connection(process.env.RPC_URL, { agent });
const privateKey = process.env.PRIVATE_KEY_SOLFLAIRE;
const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(privateKey)));

const urlApi = process.env.JUPITER_URL_QUOTE;
const inputMint = process.env.INPUT_MINT;
const outputMint = process.env.OUTPUT_MINT;
const amount = process.env.AMOUNT_SOL * 1000000000;
const slippage = process.env.SLIPPAGE;

const app = express();
app.use(bodyParser.json());

async function getQuoteAndSwap() {
    const logs = [];
    const log = (...args) => {
        const message = args.join(' ');
        logs.push(message);
        console.log(message);
    };

    try {
        const balance = await connection.getBalance(wallet.publicKey);
        log('Balance:', balance/1000000000, 'SOL');

        const minBalance = 5000/1000000000;
        if (balance < minBalance) {
            throw new Error(`Your Balance is below the minimum `, minBalance);
        }

        const quoteResponse = await fetch(`${urlApi}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`, { agent });
        if (!quoteResponse.ok) {
            throw new Error(`Failed to fetch quote: ${quoteResponse.statusText}`);
        }
        const quoteData = await quoteResponse.json();
        log('Quote Data:', JSON.stringify(quoteData));

        const swapResponse = await fetch(process.env.JUPITER_URL_SWAP, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
            }),
            agent,
        });

        if (!swapResponse.ok) {
            const swapErrorData = await swapResponse.text();
            throw new Error(`Failed to fetch swap transaction: ${swapResponse.statusText} - ${swapErrorData}`);
        }

        const swapData = await swapResponse.json();
        const { swapTransaction } = swapData;
        log('Swap Transaction:', swapTransaction);

        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        const latestBlockhash = await connection.getLatestBlockhash();
        log('Updated Blockhash:', JSON.stringify(latestBlockhash));

        transaction.message.recentBlockhash = latestBlockhash.blockhash;
        transaction.sign([wallet.payer]);

        log('Please wait, the process has started...');
        const rawTransaction = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 2,
        });

        log('Confirming transaction...');
        await connection.confirmTransaction(txid, 'processed');
        log(`Transaction ${txid} has been confirmed.`);
        return { success: true, txid, logs };
    } catch (error) {
        log('Error:', error.message);
        return { success: false, error: error.message, logs };
    }
}

app.get('/swap', async (req, res) => {
    const result = await getQuoteAndSwap();
    res.json(result);
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
