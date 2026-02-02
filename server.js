const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Agora vai funcionar!
const NUMERO_DONO = process.env.NUMERO_DONO; 
const SHEET_ID = process.env.SHEET_ID; 

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- UTILITÁRIOS ---

// 1. Forçar Data/Hora Brasil 📅
function getDataBrasilia() {
    return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// 2. Faxineira de JSON 🧹
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

// --- CONEXÃO PLANILHA ---
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
        console.error('Erro ao Salvar:', error);
        return false;
    }
}

async function lerUltimosGastos() {
    try {
        const doc = await getDoc();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows({ limit: 15, offset: 0 }); 
        if (rows.length === 0) return "A planilha está vazia.";
        
        let texto = "📊 *Atividade Recente:*\n";
        rows.forEach(row => {
            texto += `- ${row.get('Data')}: ${row.get('Item/Descrição')} | R$ ${row.get('Valor')} (${row.get('Categoria')})\n`;
        });
        return texto;
    } catch (error) {
        return "Erro ao ler a planilha.";
    }
}

// --- ROTAS ---

// 🆕 PORTA DA FRENTE (Mantém o UptimeRobot feliz e o bot acordado)
app.get('/', (req, res) => res.send('🤖 Bot Financeiro V5.0 ONLINE!'));

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
                console.log(`Acesso negado para: ${from}`);
                res.sendStatus(200);
                return;
            }

            if (msgBody) {
                try {
                    await markMessageAsRead(message.id);

                    const prompt = `
                    Você é um contador pessoal.
                    Mensagem do Usuário: "${msgBody}"
                    Data de Hoje: ${getDataBrasilia()}

                    CATEGORIAS PERMITIDAS: Alimentação, Transporte, Lazer, Casa, Contas, Saúde, Investimento, Outros.

                    REGRAS:
                    1. DESPESA/RECEITA: Retorne JSON {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Selecione a melhor", "item": "Descrição Curta", "valor": "0.00", "tipo": "Saída ou Entrada"}}
                    2. CONSULTA: Retorne JSON {"acao": "CONSULTAR"}
                    3. CONVERSA: Retorne JSON {"acao": "CONVERSAR", "resposta": "Texto curto e amigável"}
                    
                    Retorne APENAS o JSON.
                    `;

                    const result = await model.generateContent(prompt);
                    const rawText = result.response.text();
                    let ia = limparEConverterJSON(rawText);
                    let respostaFinal = "";

                    if (!ia) {
                        respostaFinal = "Não entendi. Poderia simplificar?"; 
                    } else if (ia.acao === "REGISTRAR") {
                        const salvou = await adicionarNaPlanilha(ia.dados);
                        if (salvou) respostaFinal = `✅ *Registrado!* \n📝 ${ia.dados.item}\n💸 R$ ${ia.dados.valor}\n📂 ${ia.dados.categoria}`;
                        else respostaFinal = "❌ Erro ao salvar na planilha.";
                    } else if (ia.acao === "CONSULTAR") {
                        const dadosPlanilha = await lerUltimosGastos();
                        const promptResumo = `Baseado nestes dados:\n${dadosPlanilha}\n\nResponda a pergunta do usuário: "${msgBody}".`;
                        const analise = await model.generateContent(promptResumo);
                        respostaFinal = analise.response.text();
                    } else {
                        respostaFinal = ia.resposta || "Olá!";
                    }
                    await sendMessage(from, respostaFinal);
                } catch (error) {
                    console.error('Erro Crítico do Bot:', error);
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
    } catch (error) { console.error('Erro Envio WhatsApp:', error.message); }
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

app.listen(PORT, () => console.log(`Servidor V5 rodando na porta ${PORT}`));