const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
const { getDataBrasilia, limparEConverterJSON } = require('../utils'); 
require('dotenv').config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// 🧠 PERSONALIDADE V13.2 (Profissional mas Bonito)
const SYSTEM_PROMPT = `
Você é um Assistente Financeiro Inteligente.

ESTILO DE RESPOSTA:
1. **Visual:** Use emojis para estruturar listas (ex: 💰, 📂, 📈).
2. **Estruturado:** Use Negrito para valores e nomes importantes.
3. **Direto:** Não enrole, mas seja simpático.

CAPACIDADES:
- Registrar gastos/ganhos.
- Editar/Excluir lançamentos anteriores.
- Criar categorias (Sugerir).
- Consultar dados.

REGRAS:
- "Mudar valor de X" -> EDITAR
- "Apagar X" -> EXCLUIR
- Gasto sem categoria -> SUGERIR_CRIACAO
- Assuntos aleatórios (bolo, piada) -> Recuse educadamente.
`;

async function perguntarParaGroq(prompt) {
    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt }
            ],
            temperature: 0.3
        }, { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } });
        return response.data.choices[0].message.content;
    } catch (e) { return null; }
}

async function transcreverAudio(mediaId) {
    try {
        const urlRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        const fileRes = await axios.get(urlRes.data.url, { responseType: 'arraybuffer', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        const stream = Readable.from(Buffer.from(fileRes.data));
        stream.path = 'audio.ogg'; 
        const form = new FormData();
        form.append('file', stream, { filename: 'audio.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-large-v3');
        form.append('response_format', 'json');
        const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` } });
        return res.data.text;
    } catch (e) { throw new Error("Erro transcrição"); }
}

async function analisarImagemComVision(mediaId) {
    try {
        const urlRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        const imgRes = await axios.get(urlRes.data.url, { responseType: 'arraybuffer', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        const base64Image = Buffer.from(imgRes.data).toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.2-11b-vision-preview",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "Analise nota fiscal. JSON: {\"acao\": \"REGISTRAR\", \"dados\": {\"data\": \"HOJE\", \"categoria\": \"Outros\", \"item\": \"Nome\", \"valor\": \"0.00\", \"tipo\": \"Saída\"}}" },
                    { type: "image_url", image_url: { url: dataUrl } }
                ]
            }],
            temperature: 0.1
        }, { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } });
        let json = limparEConverterJSON(response.data.choices[0].message.content);
        if (json && json.dados) json.dados.data = getDataBrasilia();
        return json;
    } catch (e) { return null; }
}

module.exports = { perguntarParaGroq, transcreverAudio, analisarImagemComVision };