const axios = require('axios');
require('dotenv').config();

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

async function sendMessage(to, text, imageUrl = null) {
    try {
        const body = { messaging_product: 'whatsapp', to: to };
        if (imageUrl) {
            body.type = 'image';
            body.image = { link: imageUrl, caption: text };
        } else {
            body.type = 'text';
            body.text = { body: text };
        }
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, body, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (e) { console.error("Erro Send:", e.message); }
}

async function sendButtonMessage(to, text, buttons) {
    try {
        const buttonActions = buttons.map(b => ({
            type: "reply",
            reply: { id: b.id, title: b.title }
        }));

        const body = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to,
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: text },
                action: { buttons: buttonActions }
            }
        };

        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, body, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (e) { console.error("Erro Button:", e.response ? e.response.data : e.message); }
}

async function markMessageAsRead(messageId) {
    try {
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (error) { }
}

module.exports = { sendMessage, sendButtonMessage, markMessageAsRead };