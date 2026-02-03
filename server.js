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

// --- UTILITÁRIOS ---
function getDataBrasilia() {
    return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function getMesAnoAtual() {
    return getDataBrasilia().substring(3); 
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

// --- 🎧 AUDIO ---
async function transcreverAudio(mediaId) {
    try {
        const urlResponse = await axios.get(
            `https://graph.facebook.com/v21.0/${mediaId}`,
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
        );
        const fileResponse = await axios.get(urlResponse.data.url, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        const stream = Readable.from(Buffer.from(fileResponse.data));
        stream.path = 'audio.ogg'; 

        const form = new FormData();
        form.append('file', stream, { filename: 'audio.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-large-v3'); 
        form.append('response_format', 'json');

        const groqResponse = await axios.post(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            form,
            { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` } }
        );
        return groqResponse.data.text;
    } catch (error) {
        throw new Error("Falha ao ouvir áudio.");
    }
}

// --- CÉREBRO (GROQ) ---
async function perguntarParaGroq(promptUsuario) {
    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: "Você é um assistente financeiro eficiente." },
                    { role: "user", content: promptUsuario }
                ],
                temperature: 0.3 
            },
            { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        return response.data.choices[0].message.content;
    } catch (error) { return null; }
}

// --- PLANILHA & LOGICA ---
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

async function getSheetParaUsuario(numeroUsuario) {
    const doc = await getDoc();
    let sheet = doc.sheetsByTitle[numeroUsuario];
    if (!sheet) {
        sheet = await doc.addSheet({ title: numeroUsuario, headerValues: ['Data', 'Categoria', 'Item/Descrição', 'Valor', 'Tipo'] });
    }
    return sheet;
}

async function getCategoriasPermitidas() {
    try {
        const doc = await getDoc();
        const sheetMetas = doc.sheetsByTitle['Metas'];
        if (!sheetMetas) return "Alimentação, Transporte, Lazer, Casa, Contas, Outros";
        const rows = await sheetMetas.getRows();
        const categorias = rows.map(row => row.get('Categoria')).filter(c => c);
        return categorias.length > 0 ? categorias.join(', ') : "Alimentação, Transporte, Lazer, Casa, Contas, Outros";
    } catch (e) { return "Alimentação, Transporte, Lazer, Casa, Contas, Outros"; }
}

// 🆕 FUNÇÃO QUE RESOLVE O PROBLEMA: SALVAR NA ABA CERTA
async function cadastrarNovoFixo(dados) {
    try {
        const doc = await getDoc();
        let sheetFixos = doc.sheetsByTitle['Fixos'];
        
        // Se a aba não existir, cria ela agora automaticamente
        if (!sheetFixos) {
            sheetFixos = await doc.addSheet({ title: 'Fixos', headerValues: ['Item', 'Valor', 'Categoria'] });
        }

        await sheetFixos.addRow({
            'Item': dados.item,
            'Valor': dados.valor,
            'Categoria': dados.categoria
        });
        return true;
    } catch (error) {
        console.error("Erro ao salvar fixo:", error);
        return false;
    }
}

async function lerDadosCompletos(numeroUsuario) {
    try {
        const doc = await getDoc();
        let relatorio = "";

        // Lê aba Fixos
        const sheetFixos = doc.sheetsByTitle['Fixos'];
        relatorio += "📌 --- CONFIGURAÇÃO DE FIXOS ---\n";
        if (sheetFixos) {
            const rowsFixos = await sheetFixos.getRows();
            if (rowsFixos.length > 0) {
                rowsFixos.forEach(row => {
                    relatorio += `- ${row.get('Item')}: R$ ${row.get('Valor')} (${row.get('Categoria')})\n`;
                });
            } else { relatorio += "(Lista vazia)\n"; }
        } else { relatorio += "(Aba não existe)\n"; }

        // Lê Extrato
        const sheetUser = await getSheetParaUsuario(numeroUsuario);
        const rowsUser = await sheetUser.getRows({ limit: 30, offset: 0 });
        relatorio += "\n📊 --- EXTRATO RECENTE ---\n";
        if (rowsUser.length > 0) {
            rowsUser.forEach(row => {
                relatorio += `- ${row.get('Data')}: ${row.get('Item/Descrição')} | R$ ${row.get('Valor')} (${row.get('Categoria')})\n`;
            });
        }

        return relatorio;
    } catch (e) { return "Erro ao ler planilhas."; }
}

async function lancarGastosFixos(numeroUsuario) {
    try {
        const doc = await getDoc();
        const sheetFixos = doc.sheetsByTitle['Fixos'];
        if (!sheetFixos) return "⚠️ Você ainda não cadastrou nenhum gasto fixo.";
        const rowsFixos = await sheetFixos.getRows();
        if (rowsFixos.length === 0) return "⚠️ Sua lista de fixos está vazia.";

        const sheetUser = await getSheetParaUsuario(numeroUsuario);
        const dataHoje = getDataBrasilia();
        let total = 0;
        let resumo = "";

        for (const row of rowsFixos) {
            const item = row.get('Item');
            const valor = row.get('Valor');
            const cat = row.get('Categoria');
            await sheetUser.addRow({
                'Data': dataHoje, 'Categoria': cat, 'Item/Descrição': item, 'Valor': valor, 'Tipo': 'Saída'
            });
            total += parseFloat(valor.replace(',', '.'));
            resumo += `▪️ ${item}: R$ ${valor}\n`;
        }
        return `✅ *Feito! Lançados para hoje:* \n\n${resumo}\n💰 Total: R$ ${total.toFixed(2)}`;
    } catch (e) { return "❌ Erro ao lançar."; }
}

async function verificarMeta(categoria, valorNovo, numeroUsuario) {
    try {
        const doc = await getDoc();
        const sheetMetas = doc.sheetsByTitle['Metas'];
        if (!sheetMetas) return "";
        const metasRows = await sheetMetas.getRows();
        const metaRow = metasRows.find(row => row.get('Categoria').toLowerCase().trim() === categoria.toLowerCase().trim());
        if (!metaRow) return ""; 

        const limite = parseFloat(metaRow.get('Limite').replace('R$', '').replace(',', '.'));
        const sheetUser = await getSheetParaUsuario(numeroUsuario);
        const gastosRows = await sheetUser.getRows();
        const mesAtual = getMesAnoAtual();
        let totalGastoMes = 0;
        gastosRows.forEach(row => {
            if (row.get('Data').includes(mesAtual) && row.get('Categoria').toLowerCase().trim() === categoria.toLowerCase().trim()) {
                totalGastoMes += parseFloat(row.get('Valor').replace('R$', '').replace(',', '.'));
            }
        });

        const totalFinal = totalGastoMes + parseFloat(valorNovo);
        if (totalFinal > limite) return `\n\n🚨 *ALERTA:* Meta de ${categoria} estourada em R$ ${(totalFinal - limite).toFixed(2)}!`;
        return "";
    } catch (e) { return ""; }
}

async function adicionarNaPlanilha(dados, numeroUsuario) {
    try {
        const sheet = await getSheetParaUsuario(numeroUsuario);
        await sheet.addRow({
            'Data': dados.data, 'Categoria': dados.categoria, 'Item/Descrição': dados.item, 'Valor': dados.valor, 'Tipo': dados.tipo
        });
        return true;
    } catch (error) { return false; }
}

// --- ROTAS ---
app.get('/', (req, res) => res.send('🤖 Bot V10.1 (Fixos OK) ONLINE!'));

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

            try {
                await markMessageAsRead(message.id);
                
                let textoParaIA = null;
                if (message.type === 'text') textoParaIA = message.text.body;
                else if (message.type === 'audio') {
                    try { textoParaIA = await transcreverAudio(message.audio.id); } 
                    catch (e) { await sendMessage(from, "❌ Erro no áudio."); }
                }

                if (textoParaIA) {
                    const txt = textoParaIA.toLowerCase();

                    // COMANDO MÁGICO: LANÇAR NO MÊS
                    if (txt.includes('lancar fixos') || txt.includes('lançar fixos')) {
                        const relatorio = await lancarGastosFixos(from);
                        await sendMessage(from, relatorio);
                        res.sendStatus(200);
                        return;
                    }

                    const categoriasPermitidas = await getCategoriasPermitidas();

                    // 🧠 PROMPT QUE ENSINA O BOT A DIFERENÇA
                    const promptClassificacao = `
                    Entrada: "${textoParaIA}"
                    Data: ${getDataBrasilia()}
                    Categorias permitidas: [${categoriasPermitidas}].

                    Classifique em UM dos JSONs:
                    1. REGISTRAR GASTO (Ocorreu hoje/agora): {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Uma das permitidas", "item": "Nome", "valor": "0.00", "tipo": "Saída/Entrada"}}
                    2. CADASTRAR/ADICIONAR NOVO FIXO (Configuração futura): {"acao": "CADASTRAR_FIXO", "dados": {"item": "Nome da conta", "valor": "0.00", "categoria": "Uma das permitidas"}}
                    3. CONSULTA (Perguntas, dúvidas, ver fixos): {"acao": "CONSULTAR"}
                    4. CONVERSA: {"acao": "CONVERSAR", "resposta": "Sua resposta"}
                    
                    Dica: Se o usuário disser "Adicione um gasto fixo", "Configure o aluguel" ou "Cadastrar conta fixa", use a opção 2 (CADASTRAR_FIXO).
                    RESPONDA APENAS O JSON.
                    `;

                    const rawClassificacao = await perguntarParaGroq(promptClassificacao);
                    let ia = limparEConverterJSON(rawClassificacao);
                    let respostaFinal = "";

                    if (!ia) {
                        respostaFinal = "Não entendi."; 
                    } 
                    else if (ia.acao === "REGISTRAR") {
                        const salvou = await adicionarNaPlanilha(ia.dados, from);
                        if (salvou) {
                            const alerta = await verificarMeta(ia.dados.categoria, ia.dados.valor, from);
                            respostaFinal = `✅ *Anotado!* \n📝 *${ia.dados.item}*\n💸 R$ ${ia.dados.valor} (${ia.dados.categoria})${alerta}`;
                        } else {
                            respostaFinal = "❌ Erro na planilha.";
                        }
                    }
                    // 👇 AQUI A SOLUÇÃO: ELE CHAMA A FUNÇÃO CERTA AGORA 👇
                    else if (ia.acao === "CADASTRAR_FIXO") {
                        const salvou = await cadastrarNovoFixo(ia.dados);
                        if (salvou) {
                            respostaFinal = `📌 *Configurado com Sucesso!* \n\nAdicionei "${ia.dados.item}" (R$ ${ia.dados.valor}) na sua lista de gastos fixos.`;
                        } else {
                            respostaFinal = "❌ Erro ao salvar na aba Fixos.";
                        }
                    }
                    else if (ia.acao === "CONSULTAR") {
                        const dadosCompletos = await lerDadosCompletos(from);
                        const promptResumo = `
                        CONTEXTO: Assistente financeiro.
                        DATA: ${getDataBrasilia()}
                        DADOS: ${dadosCompletos}
                        
                        INSTRUÇÃO: Responda à pergunta "${textoParaIA}" usando os dados acima.
                        Se a pergunta for "quais são meus fixos", LEIA a seção "CONFIGURAÇÃO DE FIXOS".
                        ESTILO: WhatsApp.
                        JSON RESPOSTA: {"resposta": "Texto"}
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

            } catch (error) { console.error('Erro Geral:', error); }
        }
        res.sendStatus(200);
    } else { res.sendStatus(404); }
});

async function sendMessage(to, text) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
            data: { messaging_product: 'whatsapp', to: to, text: { body: text } }
        });
    } catch (error) { }
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

app.listen(PORT, () => console.log(`Servidor V10.1 rodando na porta ${PORT}`));