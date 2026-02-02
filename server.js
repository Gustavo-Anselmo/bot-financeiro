const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('./google.json'); 
require('dotenv').config();

const app = express();
app.use(express.json());

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.MY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NUMERO_DONO = process.env.NUMERO_DONO; 
const SHEET_ID = process.env.SHEET_ID; 

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// --- FUNÇÃO FAXINEIRA (O Segredo da Inteligência) 🧹 ---
function limparEConverterJSON(texto) {
    try {
        // 1. Remove formatação de código do Markdown (```json ... ```)
        let limpo = texto.replace(/```json|```/g, "").trim();
        
        // 2. Tenta encontrar onde começa '{' e termina '}' para ignorar textos extras
        const inicio = limpo.indexOf('{');
        const fim = limpo.lastIndexOf('}');
        
        if (inicio !== -1 && fim !== -1) {
            limpo = limpo.substring(inicio, fim + 1);
        }

        return JSON.parse(limpo);
    } catch (e) {
        console.error("Erro ao limpar JSON:", e);
        return null; // Retorna nulo se falhar feio
    }
}

// --- CONEXÃO COM A PLANILHA ---
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
        console.error('Erro ao salvar:', error);
        return false;
    }
}

async function lerUltimosGastos() {
    try {
        const doc = await getDoc();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows({ limit: 20, offset: 0 }); // Lê as últimas 20
        
        if (rows.length === 0) return "A planilha está vazia.";

        let texto = "Histórico Recente:\n";
        rows.forEach(row => {
            texto += `- ${row.get('Data')}: ${row.get('Item/Descrição')} (R$ ${row.get('Valor')})\n`;
        });
        return texto;
    } catch (error) {
        return "Erro ao ler dados.";
    }
}

// --- ROTAS ---
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

            // Filtro de Segurança (Seu Número)
            if (from !== NUMERO_DONO) {
                res.sendStatus(200);
                return;
            }

            if (msgBody) {
                try {
                    await markMessageAsRead(message.id);

                    // --- PROMPT MAIS HUMANO E TOLERANTE ---
                    const prompt = `
                    Aja como um assistente financeiro pessoal, inteligente e amigável.
                    O usuário enviou: "${msgBody}"
                    Data de hoje: ${new Date().toLocaleDateString('pt-BR')}

                    Sua missão é entender a intenção, corrigir pequenos erros de digitação e responder.
                    
                    REGRAS:
                    1. Se o usuário informar um gasto ou ganho (ex: "comprei pão 10", "recebi 50", "gastei 20 no uber"), extraia os dados. Corrija erros (ex: "raies" -> "Reais").
                       Retorne JSON: {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Escolha a melhor", "item": "Descrição curta", "valor": "0.00", "tipo": "Saída ou Entrada"}}
                    
                    2. Se o usuário perguntar sobre gastos passados (ex: "quanto gastei?", "saldo", "histórico"), retorne JSON: {"acao": "CONSULTAR"}

                    3. Se for conversa fiada, dúvidas gerais ou algo que não dê para registrar (ex: "oi", "qual o sentido da vida", "erro no sistema"), seja simpático.
                       Retorne JSON: {"acao": "CONVERSAR", "resposta": "Sua resposta textual aqui"}

                    IMPORTANTE: Responda APENAS o JSON. Sem markdown.
                    `;

                    const result = await model.generateContent(prompt);
                    const rawText = result.response.text();
                    
                    // Usa a Faxineira para garantir que o JSON funcione
                    let ia = limparEConverterJSON(rawText);

                    let respostaFinal = "";

                    if (!ia) {
                        // Se a IA ficou maluca e não mandou JSON, a gente trata como conversa
                        respostaFinal = rawText; 
                    } else if (ia.acao === "REGISTRAR") {
                        const salvou = await adicionarNaPlanilha(ia.dados);
                        if (salvou) respostaFinal = `✅ *Registrado!* \n📝 ${ia.dados.item}\n💸 R$ ${ia.dados.valor}\n📂 ${ia.dados.categoria}`;
                        else respostaFinal = "❌ Erro ao conectar na planilha. Verifique o ID no Render.";
                    
                    } else if (ia.acao === "CONSULTAR") {
                        const dadosPlanilha = await lerUltimosGastos();
                        // Pede para a IA analisar os dados lidos
                        const promptResumo = `Responda a pergunta "${msgBody}" baseando-se nestes dados da planilha:\n${dadosPlanilha}. Seja resumido e útil.`;
                        const analise = await model.generateContent(promptResumo);
                        respostaFinal = analise.response.text();

                    } else {
                        // É conversa ou a IA não entendeu como gasto
                        respostaFinal = ia.resposta || rawText;
                    }

                    await sendMessage(from, respostaFinal);

                } catch (error) {
                    console.error('Erro crítico:', error);
                    // Não mandamos mensagem de erro para o usuário para não poluir o chat, apenas logamos no Render.
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
    } catch (error) { console.error('Erro envio:', error.message); }
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

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));