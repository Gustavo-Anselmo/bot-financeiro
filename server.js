const express = require('express');
const axios = require('axios');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.MY_TOKEN; // Seu token de verificação (definido no dashboard)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Token da API do WhatsApp
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // ID do número de telefone
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Sua chave da IA

// 🔒 TRAVA DE SEGURANÇA (WHITELIST)
// Substitua o número abaixo pelo SEU número (exatamente como aparece nos logs do Render)
// Exemplo: "5575999998888" (DDI + DDD + Número)
const NUMERO_DONO = "5575xxxxxxxxx"; 

// Inicializando a IA do Google (Gemini)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Rota de verificação do Webhook (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === MY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// Rota de recebimento de mensagens (POST)
app.post('/webhook', async (req, res) => {
    const body = req.body;

    console.log('Recebendo webhook...');

    if (body.object) {
        if (body.entry && 
            body.entry[0].changes && 
            body.entry[0].changes[0].value.messages && 
            body.entry[0].changes[0].value.messages[0]
        ) {
            const message = body.entry[0].changes[0].value.messages[0];
            const from = message.from; // Quem enviou
            const msgBody = message.text ? message.text.body : null;

            console.log(`Mensagem recebida de: ${from}`);
            console.log(`Conteúdo: ${msgBody}`);

            // --- 🔒 INÍCIO DA SEGURANÇA ---
            // Se o número de quem enviou for DIFERENTE do seu número, a gente ignora.
            if (from !== NUMERO_DONO) {
                console.log(`🚫 Acesso negado para o intruso: ${from}`);
                res.sendStatus(200); // Responde 200 pro WhatsApp não reenviar, mas não faz nada.
                return;
            }
            // --- 🔒 FIM DA SEGURANÇA ---

            if (msgBody) {
                try {
                    // 1. Marca a mensagem como lida (opcional, mas bom pra UX)
                    await markMessageAsRead(message.id);

                    // 2. Envia para a IA (Gemini)
                    console.log('Perguntando para o Gemini...');
                    const result = await model.generateContent(msgBody);
                    const responseText = result.response.text();

                    // 3. Responde no WhatsApp
                    console.log('Respondendo usuário...');
                    await sendMessage(from, responseText);

                } catch (error) {
                    console.error('Erro ao processar mensagem:', error);
                    await sendMessage(from, "Desculpe, tive um erro ao processar sua mensagem.");
                }
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Função auxiliar para enviar mensagem
async function sendMessage(to, text) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: text }
            }
        });
    } catch (error) {
        console.error('Erro ao enviar mensagem no WhatsApp:', error.response ? error.response.data : error.message);
    }
}

// Função auxiliar para marcar como lida
async function markMessageAsRead(messageId) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            data: {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId
            }
        });
    } catch (error) {
        // Não precisa travar o bot se falhar ao marcar como lida
        console.error('Erro ao marcar como lida (não crítico):', error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});