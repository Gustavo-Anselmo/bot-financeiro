const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { Readable } = require('stream'); 
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
const SHEET_ID = process.env.SHEET_ID; 
// Nota: Removemos a restrição de NUMERO_DONO para permitir outros users

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

// --- 🎧 FUNÇÃO DE OUVIDO ---
async function transcreverAudio(mediaId) {
    try {
        console.log(`🎧 Baixando áudio ID: ${mediaId}`);
        const urlResponse = await axios.get(
            `https://graph.facebook.com/v21.0/${mediaId}`,
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
        const mediaUrl = urlResponse.data.url;

        const fileResponse = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        
        const buffer = Buffer.from(fileResponse.data);
        const stream = Readable.from(buffer);
        stream.path = 'audio.ogg'; 

        const form = new FormData();
        form.append('file', stream, { filename: 'audio.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-large-v3'); 
        form.append('response_format', 'json');

        const groqResponse = await axios.post(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            form,
            {
                headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` },
                maxBodyLength: Infinity, maxContentLength: Infinity
            }
        );
        return groqResponse.data.text;

    } catch (error) {
        console.error("❌ Erro Áudio:", error.message);
        throw new Error("Falha ao ouvir áudio.");
    }
}

// --- FUNÇÃO CÉREBRO (GROQ) ---
async function perguntarParaGroq(promptUsuario) {
    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: "Você é um assistente financeiro." },
                    { role: "user", content: promptUsuario }
                ],
                temperature: 0.3 
            },
            {
                headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }
            }
        );
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Erro Groq:", error.message);
        return null;
    }
}

// --- GERENCIADOR DE PLANILHAS (FAMÍLIA) 👨‍👩‍👧 ---
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

// Encontra ou cria uma aba para o usuário
async function getSheetParaUsuario(numeroUsuario) {
    const doc = await getDoc();
    
    // Tenta achar uma aba com o número da pessoa
    let sheet = doc.sheetsByTitle[numeroUsuario];
    
    // Se não existir, cria uma nova aba para ela
    if (!sheet) {
        console.log(`Criando nova aba para: ${numeroUsuario}`);
        sheet = await doc.addSheet({ title: numeroUsuario, headerValues: ['Data', 'Categoria', 'Item/Descrição', 'Valor', 'Tipo'] });
    }
    return sheet;
}

async function adicionarNaPlanilha(dados, numeroUsuario) {
    try {
        const sheet = await getSheetParaUsuario(numeroUsuario);
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

async function lerUltimosGastos(numeroUsuario) {
    try {
        const sheet = await getSheetParaUsuario(numeroUsuario);
        const rows = await sheet.getRows({ limit: 30, offset: 0 }); 
        
        if (rows.length === 0) return "A planilha está vazia.";
        
        let texto = "";
        rows.forEach(row => {
            const data = row.get('Data') || 'S/D';
            const item = row.get('Item/Descrição') || 'Item';
            const valor = row.get('Valor') || '0';
            const cat = row.get('Categoria') || 'Geral';
            texto += `- Dia ${data}: ${item} | R$ ${valor} (${cat})\n`;
        });
        return texto;
    } catch (error) {
        console.error("Erro leitura:", error);
        return "Erro ao ler dados da planilha.";
    }
}

// --- ROTAS ---
app.get('/', (req, res) => res.send('🤖 Bot V7.0 (Família) ONLINE!'));

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
            const from = message.from; // Número de quem enviou (Sua mãe, você, etc.)
            const nomeUsuario = message.from; // Usaremos o número como "Nome" da aba
            
            // REMOVI A TRAVA DE SEGURANÇA QUE SÓ ACEITAVA SEU NÚMERO
            // Agora qualquer pessoa na lista de teste do Meta pode usar

            try {
                await markMessageAsRead(message.id);
                
                let textoParaIA = null;
                if (message.type === 'text') textoParaIA = message.text.body;
                else if (message.type === 'audio') {
                    try { textoParaIA = await transcreverAudio(message.audio.id); } 
                    catch (e) { await sendMessage(from, "❌ Erro no áudio."); }
                }

                if (textoParaIA) {
                    // 1. CLASSIFICAR
                    const promptClassificacao = `
                    Entrada: "${textoParaIA}"
                    Data: ${getDataBrasilia()}

                    Classifique em UM dos JSONs:
                    1. GASTO/GANHO: {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Categoria", "item": "Nome", "valor": "0.00", "tipo": "Saída/Entrada"}}
                    2. CONSULTA: {"acao": "CONSULTAR"}
                    3. CONVERSA: {"acao": "CONVERSAR", "resposta": "Sua resposta"}
                    
                    RESPONDA APENAS O JSON.
                    `;

                    const rawClassificacao = await perguntarParaGroq(promptClassificacao);
                    let ia = limparEConverterJSON(rawClassificacao);
                    let respostaFinal = "";

                    if (!ia) {
                        respostaFinal = "Erro de entendimento."; 
                    } 
                    else if (ia.acao === "REGISTRAR") {
                        // Passamos o 'from' (número) para saber em qual aba salvar
                        const salvou = await adicionarNaPlanilha(ia.dados, from);
                        if (salvou) respostaFinal = `✅ *Anotado!* \n📝 *${ia.dados.item}*\n💸 R$ ${ia.dados.valor}`;
                        else respostaFinal = "❌ Erro na planilha.";
                    } 
                    else if (ia.acao === "CONSULTAR") {
                        // Lê apenas a aba desse número específico
                        const dadosPlanilha = await lerUltimosGastos(from);
                        
                        const promptResumo = `
                        CONTEXTO: Contador pessoal.
                        DATA: ${getDataBrasilia()}
                        DADOS DE QUEM PERGUNTOU (${from}):
                        ${dadosPlanilha}

                        INSTRUÇÃO: Responda à pergunta "${textoParaIA}" usando APENAS os dados acima.
                        
                        ESTILO WHATSAPP:
                        - Use emojis.
                        - *Negrito* nos valores.
                        - Lista com marcadores.

                        Responda em formato JSON: {"resposta": "Seu texto formatado aqui"}
                        `;
                        
                        const resumoRaw = await perguntarParaGroq(promptResumo);
                        const resumoJson = limparEConverterJSON(resumoRaw);
                        respostaFinal = (resumoJson && resumoJson.resposta) ? resumoJson.resposta : resumoRaw;
                    } 
                    else {
                        respostaFinal = ia.resposta || "Olá!";
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

app.listen(PORT, () => console.log(`Servidor V7.0 rodando na porta ${PORT}`));