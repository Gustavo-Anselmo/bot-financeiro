const express = require('express');
const axios = require('axios');
// Removemos a linha do GoogleGenerativeAI pois vamos usar Groq via Axios
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('./google.json'); 
require('dotenv').config();

const app = express();
app.use(express.json());

// --- CONFIGURAÇÃO ---
const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.MY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
// Usando a chave que você já tem no Render
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

// --- FUNÇÃO PARA CHAMAR A GROQ (Substitui o Gemini) ---
async function perguntarParaGroq(promptUsuario) {
    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: "llama3-8b-8192", // Modelo rápido e inteligente da Meta
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
        console.error("Erro na Groq:", error.response ? error.response.data : error.message);
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
app.get('/', (req, res) => res.send('🤖 Bot (Versão Groq/Llama) ONLINE!'));

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
            const msgBody = message.text ? message.text.body : null;

            if (from !== NUMERO_DONO) {
                console.log(`Bloqueado: ${from}`);
                res.sendStatus(200);
                return;
            }

            if (msgBody) {
                try {
                    await markMessageAsRead(message.id);

                    const prompt = `
                    Atue como contador.
                    Msg: "${msgBody}"
                    Hoje: ${getDataBrasilia()}

                    CATEGORIAS: Alimentação, Transporte, Lazer, Casa, Contas, Saúde, Investimento, Outros.

                    REGRAS:
                    1. GASTO/GANHO -> JSON: {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Escolha", "item": "Resumo", "valor": "0.00", "tipo": "Saída ou Entrada"}}
                    2. CONSULTA -> JSON: {"acao": "CONSULTAR"}
                    3. PAPO -> JSON: {"acao": "CONVERSAR", "resposta": "Sua resposta curta"}
                    
                    RESPONDA APENAS O JSON PURO.
                    `;

                    // Chamando a nova função do Groq
                    const rawText = await perguntarParaGroq(prompt);
                    let ia = limparEConverterJSON(rawText);
                    let respostaFinal = "";

                    if (!ia) {
                        respostaFinal = "Tive um erro de conexão com o cérebro (Groq). Tente de novo."; 
                    } else if (ia.acao === "REGISTRAR") {
                        const salvou = await adicionarNaPlanilha(ia.dados);
                        if (salvou) respostaFinal = `✅ *Anotado!* \n📝 ${ia.dados.item}\n💸 R$ ${ia.dados.valor}\n📂 ${ia.dados.categoria}`;
                        else respostaFinal = "❌ Erro na planilha.";
                    } else if (ia.acao === "CONSULTAR") {
                        const dadosPlanilha = await lerUltimosGastos();
                        // Pergunta secundária para a Groq resumir os dados
                        const resumo = await perguntarParaGroq(`Analise estes dados e responda a pergunta "${msgBody}":\n${dadosPlanilha}`);
                        // Se a Groq retornar JSON no resumo (às vezes acontece), tentamos pegar o texto, senão usamos o raw
                        const jsonResumo = limparEConverterJSON(resumo);
                        respostaFinal = jsonResumo && jsonResumo.resposta ? jsonResumo.resposta : resumo;
                    } else {
                        respostaFinal = ia.resposta || "Oi!";
                    }
                    await sendMessage(from, respostaFinal);
                } catch (error) {
                    console.error('Erro Geral:', error);
                }
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

app.listen(PORT, () => console.log(`Servidor Groq rodando na porta ${PORT}`));