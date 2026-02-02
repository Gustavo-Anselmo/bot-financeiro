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
                    { role: "system", content: "Você é um assistente financeiro." }, // Removi a regra estrita de JSON aqui para a consulta funcionar melhor
                    { role: "user", content: promptUsuario }
                ],
                temperature: 0.3 // Diminui a criatividade para ele ser mais exato
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
        // Lê as últimas 30 linhas para garantir
        const rows = await sheet.getRows({ limit: 30, offset: 0 }); 
        
        if (rows.length === 0) {
            console.log("Planilha vazia ou erro de leitura.");
            return "A planilha está vazia.";
        }
        
        let texto = "";
        rows.forEach(row => {
            // Monta uma string segura
            const data = row.get('Data') || 'S/D';
            const item = row.get('Item/Descrição') || 'Item';
            const valor = row.get('Valor') || '0';
            const cat = row.get('Categoria') || 'Geral';
            texto += `- Dia ${data}: ${item} | R$ ${valor} (${cat})\n`;
        });
        
        console.log("Dados lidos da planilha:", texto); // LOG NO TERMINAL PARA DEBUG
        return texto;
    } catch (error) {
        console.error("Erro leitura detalhado:", error);
        return "Erro ao ler dados da planilha.";
    }
}

// --- ROTAS ---
app.get('/', (req, res) => res.send('🤖 Bot V6.3 (Autoridade) ONLINE!'));

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
                if (message.type === 'text') textoParaIA = message.text.body;
                else if (message.type === 'audio') {
                    try { textoParaIA = await transcreverAudio(message.audio.id); } 
                    catch (e) { await sendMessage(from, "❌ Erro no áudio."); }
                }

                if (textoParaIA) {
                    // PROMPT INICIAL - CLASSIFICADOR
                    const promptClassificacao = `
                    Você é um processador de dados.
                    Entrada: "${textoParaIA}"
                    Data de Hoje: ${getDataBrasilia()}

                    Classifique a intenção em APENAS UM dos JSONs abaixo:
                    1. GASTO/GANHO: {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Categoria", "item": "Nome", "valor": "0.00", "tipo": "Saída/Entrada"}}
                    2. CONSULTA (Perguntas sobre saldo, gastos, resumo): {"acao": "CONSULTAR"}
                    3. CONVERSA (Oi, tudo bem, etc): {"acao": "CONVERSAR", "resposta": "Sua resposta"}
                    
                    RESPONDA APENAS O JSON.
                    `;

                    const rawClassificacao = await perguntarParaGroq(promptClassificacao);
                    let ia = limparEConverterJSON(rawClassificacao);
                    let respostaFinal = "";

                    if (!ia) {
                        respostaFinal = "Erro de entendimento. Tente novamente."; 
                    } 
                    else if (ia.acao === "REGISTRAR") {
                        const salvou = await adicionarNaPlanilha(ia.dados);
                        if (salvou) respostaFinal = `✅ *Anotado!* \n📝 ${ia.dados.item}\n💸 R$ ${ia.dados.valor}`;
                        else respostaFinal = "❌ Erro na planilha.";
                    } 
                    else if (ia.acao === "CONSULTAR") {
                        const dadosPlanilha = await lerUltimosGastos();
                        
                        // PROMPT SECUNDÁRIO - O ANALISTA
                        // Aqui mudamos a ordem para obrigar ele a usar os dados
                        const promptResumo = `
                        CONTEXTO: Você é um contador pessoal e tem acesso total aos dados financeiros abaixo.
                        DATA DE HOJE: ${getDataBrasilia()}
                        
                        DADOS DA PLANILHA (FONTE DA VERDADE):
                        ${dadosPlanilha}

                        INSTRUÇÃO: Responda à pergunta do usuário usando APENAS os dados acima.
                        Se a pergunta for "gastos do dia", some apenas os itens com a data de hoje.
                        NÃO peça permissão. NÃO diga que precisa de dados. ELES ESTÃO AQUI.
                        
                        Pergunta do usuário: "${textoParaIA}"

                        Responda em formato JSON: {"resposta": "Seu texto resumido aqui"}
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

app.listen(PORT, () => console.log(`Servidor V6.3 rodando na porta ${PORT}`));