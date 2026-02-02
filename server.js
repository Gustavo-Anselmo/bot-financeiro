const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { Readable } = require('stream'); // Nova importação importante
const creds = require('./google.json'); 
require('dotenv').config();

const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO ---
const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.MY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY; 
const NUMERO_DONO = process.env.NUMERO_DONO; 
const SHEET_ID = process.env.SHEET_ID; 

// --- UTILITÁRIOS ---
function getDataBrasilia() {
    return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function limparEConverterJSON(texto) {
    try {
        let limpo = texto.replace(/```json|```/g, "").trim();
        const inicio = limpo.indexOf('{');
        const fim = limpo.lastIndexOf('}');
        if (inicio !== -1 && fim !== -1) {
            limpo = limpo.substring(inicio, fim + 1);
        }
        return JSON.parse(limpo);
    } catch (e) {
        console.error("Erro JSON:", e);
        return null;
    }
}

// --- 🎧 FUNÇÃO DE OUVIDO (TRANSCRICÃO ROBUSTA) ---
async function transcreverAudio(mediaId) {
    try {
        console.log(`🎧 1. Iniciando download do áudio ID: ${mediaId}`);
        
        // 1. Pegar URL
        const urlResponse = await axios.get(
            `https://graph.facebook.com/v21.0/${mediaId}`,
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
        const mediaUrl = urlResponse.data.url;
        console.log(`🎧 2. URL obtida. Baixando binário...`);

        // 2. Baixar Arquivo
        const fileResponse = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        
        const buffer = Buffer.from(fileResponse.data);
        console.log(`🎧 3. Download concluído. Tamanho: ${buffer.length} bytes`);

        // 3. Converter para Stream (Mais seguro para upload)
        const stream = Readable.from(buffer);
        // Hack para o form-data reconhecer o path (necessário em alguns casos)
        stream.path = 'audio.ogg'; 

        // 4. Preparar envio para Groq
        const form = new FormData();
        form.append('file', stream, { filename: 'audio.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-large-v3'); // Modelo Multilíngue
        form.append('response_format', 'json');

        console.log(`🎧 4. Enviando para Groq Whisper...`);
        const groqResponse = await axios.post(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            }
        );

        console.log(`🗣️ Transcrição Sucesso: "${groqResponse.data.text}"`);
        return groqResponse.data.text;

    } catch (error) {
        console.error("❌ Erro Detalhado no Áudio:", error.response ? error.response.data : error.message);
        throw new Error(`Falha no áudio: ${error.message}`); // Lança erro para avisar o usuário
    }
}

// --- FUNÇÃO CÉREBRO (GROQ LLAMA 3.3) ---
async function perguntarParaGroq(promptUsuario) {
    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: "llama-3.3-70b-versatile", // Modelo mais inteligente
                messages: [
                    { role: "system", content: "Você é um assistente financeiro que SEMPRE responde apenas em JSON." },
                    { role: "user", content: promptUsuario }
                ],
                temperature: 0.5
            },
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Erro na Groq Llama:", error.message);
        return null;
    }
}

// --- PLANILHA ---
async function getDoc() {
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    return doc;
}

async function adicionarNaPlanilha(dados) {
    try {
        const doc = await getDoc();
        const sheet = doc.sheetsByIndex[0]; 
        await sheet.addRow({
            'Data': dados.data,
            'Categoria': dados.categoria,
            'Item/Descrição': dados.item,
            'Valor': dados.valor,
            'Tipo': dados.tipo
        });
        return true;
    } catch (error) {
        console.error('Erro Planilha:', error);
        return false;
    }
}

async function lerUltimosGastos() {
    try {
        const doc = await getDoc();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows({ limit: 15, offset: 0 }); 
        if (rows.length === 0) return "A planilha está vazia.";
        
        let texto = "📊 *Extrato Recente:*\n";
        rows.forEach(row => {
            texto += `- ${row.get('Data')}: ${row.get('Item/Descrição')} | R$ ${row.get('Valor')} (${row.get('Categoria')})\n`;
        });
        return texto;
    } catch (error) {
        return "Erro ao ler planilha.";
    }
}

// --- ROTAS ---
app.get('/', (req, res) => res.send('🤖 Bot V6.1 (Áudio Debug) ONLINE!'));

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === MY_TOKEN) res.status(200).send(challenge);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object) {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            const message = body.entry[0].changes[0].value.messages[0];
            const from = message.from;
            
            if (from !== NUMERO_DONO) {
                res.sendStatus(200);
                return;
            }

            try {
                await markMessageAsRead(message.id);
                
                let textoParaIA = null;

                // 📝 TEXTO
                if (message.type === 'text') {
                    textoParaIA = message.text.body;
                } 
                // 🎤 ÁUDIO
                else if (message.type === 'audio') {
                    // Avisa que recebeu
                    // await sendMessage(from, "🎧 Ouvindo...");
                    try {
                        textoParaIA = await transcreverAudio(message.audio.id);
                    } catch (e) {
                        await sendMessage(from, `❌ Erro no áudio: ${e.message}`);
                        textoParaIA = null;
                    }
                }

                // PROCESSAR (Se tiver texto válido)
                if (textoParaIA) {
                    const prompt = `
                    Atue como contador.
                    Msg do Usuário: "${textoParaIA}"
                    Hoje: ${getDataBrasilia()}

                    CATEGORIAS: Alimentação, Transporte, Lazer, Casa, Contas, Saúde, Investimento, Outros.

                    REGRAS:
                    1. GASTO/GANHO -> JSON: {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Escolha", "item": "Resumo", "valor": "0.00", "tipo": "Saída ou Entrada"}}
                    2. CONSULTA -> JSON: {"acao": "CONSULTAR"}
                    3. PAPO -> JSON: {"acao": "CONVERSAR", "resposta": "Sua resposta curta"}
                    
                    RESPONDA APENAS O JSON PURO.
                    `;

                    const rawText = await perguntarParaGroq(prompt);
                    let ia = limparEConverterJSON(rawText);
                    let respostaFinal = "";

                    if (!ia) {
                        respostaFinal = "Não entendi. Tente falar mais devagar ou digite."; 
                    } else if (ia.acao === "REGISTRAR") {
                        const salvou = await adicionarNaPlanilha(ia.dados);
                        if (salvou) respostaFinal = `✅ *Anotado!* \n📝 ${ia.dados.item}\n💸 R$ ${ia.dados.valor}\n📂 ${ia.dados.categoria}`;
                        else respostaFinal = "❌ Erro na planilha.";
                    } else if (ia.acao === "CONSULTAR") {
                        const dadosPlanilha = await lerUltimosGastos();
                        const resumo = await perguntarParaGroq(`Responda "${textoParaIA}" com base em:\n${dadosPlanilha}`);
                        const jsonResumo = limparEConverterJSON(resumo);
                        respostaFinal = jsonResumo && jsonResumo.resposta ? jsonResumo.resposta : resumo;
                    } else {
                        respostaFinal = ia.resposta || "Oi!";
                    }
                    await sendMessage(from, respostaFinal);
                }

            } catch (error) {
                console.error('Erro Geral:', error);
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

async function sendMessage(to, text) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            data: { messaging_product: 'whatsapp', to: to, text: { body: text } }
        });
    } catch (error) { console.error('Erro Zap:', error.message); }
}

async function markMessageAsRead(messageId) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            data: { messaging_product: 'whatsapp', status: 'read', message_id: messageId }
        });
    } catch (error) { }
}

app.listen(PORT, () => console.log(`Servidor V6.1 rodando na porta ${PORT}`));