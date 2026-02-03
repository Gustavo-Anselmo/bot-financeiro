const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { Readable } = require('stream');
const cron = require('node-cron');
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
        if (inicio !== -1 && fim !== -1) limpo = limpo.substring(inicio, fim + 1);
        return JSON.parse(limpo);
    } catch (e) { return null; }
}

// --- 👁️ VISÃO COMPUTACIONAL (OCR DE NOTAS) ---
async function analisarImagemComVision(mediaId) {
    try {
        // 1. Pega a URL da imagem no WhatsApp
        const urlRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        // 2. Baixa a imagem como "ArrayBuffer"
        const imgRes = await axios.get(urlRes.data.url, { responseType: 'arraybuffer', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        // 3. Converte para Base64
        const base64Image = Buffer.from(imgRes.data).toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;

        // 4. Manda para o Llama Vision (Groq)
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.2-11b-vision-preview", // Modelo que enxerga!
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Analise esta imagem de recibo/nota fiscal. Extraia: Item principal (ou nome da loja), Valor Total e tente adivinhar a Categoria. Data use a de hoje se não tiver na nota. Retorne APENAS um JSON: {\"acao\": \"REGISTRAR\", \"dados\": {\"data\": \"DD/MM/AAAA\", \"categoria\": \"Categoria\", \"item\": \"Nome\", \"valor\": \"0.00\", \"tipo\": \"Saída\"}}" },
                        { type: "image_url", image_url: { url: dataUrl } }
                    ]
                }
            ],
            temperature: 0.1
        }, { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Erro Vision:", error.response ? error.response.data : error.message);
        return null;
    }
}

// --- 📊 GERADOR DE GRÁFICOS (QUICKCHART) ---
async function gerarGraficoPizza(numeroUsuario) {
    try {
        const doc = await getDoc();
        const sheetUser = await getSheetParaUsuario(numeroUsuario);
        const rows = await sheetUser.getRows({ limit: 100 }); // Pega últimos 100
        const mesAtual = getMesAnoAtual();

        // Agrega dados
        const gastosPorCat = {};
        rows.forEach(row => {
            if (row.get('Data').includes(mesAtual) && row.get('Tipo') === 'Saída') {
                const cat = row.get('Categoria');
                const val = parseFloat(row.get('Valor').replace('R$', '').replace(',', '.'));
                if (!gastosPorCat[cat]) gastosPorCat[cat] = 0;
                gastosPorCat[cat] += val;
            }
        });

        if (Object.keys(gastosPorCat).length === 0) return null;

        const labels = Object.keys(gastosPorCat);
        const data = Object.values(gastosPorCat);

        // Cria URL do QuickChart
        const chartConfig = {
            type: 'pie',
            data: {
                labels: labels,
                datasets: [{ data: data, backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF'] }]
            },
            options: { 
                title: { display: true, text: `Gastos de ${mesAtual}` },
                plugins: { datalabels: { color: 'white', font: { weight: 'bold' } } }
            }
        };
        
        const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=300`;
        return url;

    } catch (e) { console.error(e); return null; }
}

// --- PLANILHA CORE ---
async function getDoc() {
    const serviceAccountAuth = new JWT({ email: creds.client_email, key: creds.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    return doc;
}
async function getSheetParaUsuario(numeroUsuario) {
    const doc = await getDoc();
    let sheet = doc.sheetsByTitle[numeroUsuario];
    if (!sheet) sheet = await doc.addSheet({ title: numeroUsuario, headerValues: ['Data', 'Categoria', 'Item/Descrição', 'Valor', 'Tipo'] });
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

// --- FUNÇÕES DE AÇÃO ---
async function inscreverUsuario(numero) {
    try {
        const doc = await getDoc();
        let sheetUsers = doc.sheetsByTitle['Usuarios'];
        if (!sheetUsers) sheetUsers = await doc.addSheet({ title: 'Usuarios', headerValues: ['Numero', 'Ativo'] });
        const rows = await sheetUsers.getRows();
        if (rows.find(row => row.get('Numero') === numero)) return "✅ Já está ativo!";
        await sheetUsers.addRow({ 'Numero': numero, 'Ativo': 'Sim' });
        return "🔔 Notificações Ativadas!";
    } catch (e) { return "Erro."; }
}
async function cadastrarNovoFixo(dados) {
    const doc = await getDoc();
    let sheetFixos = doc.sheetsByTitle['Fixos'];
    if (!sheetFixos) sheetFixos = await doc.addSheet({ title: 'Fixos', headerValues: ['Item', 'Valor', 'Categoria'] });
    await sheetFixos.addRow({ 'Item': dados.item, 'Valor': dados.valor, 'Categoria': dados.categoria });
    return true;
}
async function adicionarNaPlanilha(dados, numeroUsuario) {
    const sheet = await getSheetParaUsuario(numeroUsuario);
    await sheet.addRow({ 'Data': dados.data, 'Categoria': dados.categoria, 'Item/Descrição': dados.item, 'Valor': dados.valor, 'Tipo': dados.tipo });
    return true;
}
async function verificarMeta(categoria, valorNovo, numeroUsuario) {
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
    if ((totalGastoMes + parseFloat(valorNovo)) > limite) return `\n\n🚨 *ESTOUROU A META!*`;
    return "";
}

// --- ARQUIVO DE ÁUDIO ---
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
        const groq = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` } });
        return groq.data.text;
    } catch (e) { throw new Error("Erro audio"); }
}

// --- CÉREBRO TEXTO ---
async function perguntarParaGroq(prompt) {
    try {
        const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "system", content: "Assistente financeiro." }, { role: "user", content: prompt }],
            temperature: 0.3 
        }, { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } });
        return res.data.choices[0].message.content;
    } catch (e) { return null; }
}

// --- SEND MESSAGE (TEXTO & IMAGEM) ---
async function sendMessage(to, text, imageUrl = null) {
    try {
        const body = { messaging_product: 'whatsapp', to: to };
        if (imageUrl) {
            body.type = 'image';
            body.image = { link: imageUrl, caption: text };
        } else {
            body.text = { body: text };
        }
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, body, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (e) { console.error("Erro envio Zap"); }
}

// --- CRON JOBS ---
function iniciarAgendamentos() {
    cron.schedule('40 09 * * 1-5', async () => {
        const doc = await getDoc();
        const sheetUsers = doc.sheetsByTitle['Usuarios'];
        if (!sheetUsers) return;
        const rows = await sheetUsers.getRows();
        const ativos = rows.filter(r => r.get('Ativo') === 'Sim');
        ativos.forEach(r => sendMessage(r.get('Numero'), "🥪 Hora do lanche! Se gastou, avise."));
    }, { scheduled: true, timezone: "America/Sao_Paulo" });
}
iniciarAgendamentos();

// --- WEBHOOK ---
app.get('/', (req, res) => res.send('🤖 Bot V12.0 (Vision & Charts) ONLINE!'));
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === MY_TOKEN) res.status(200).send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from;

        try {
            let textoParaIA = null;
            let ia = null; // Objeto final de comando

            // 1. SE FOR IMAGEM (OCR) 📸
            if (message.type === 'image') {
                await sendMessage(from, "👁️ Analisando sua nota fiscal... aguarde.");
                const jsonVision = await analisarImagemComVision(message.image.id);
                if (jsonVision) {
                    ia = limparEConverterJSON(jsonVision); // Já sai pronto para registrar!
                } else {
                    await sendMessage(from, "❌ Não consegui ler a imagem.");
                }
            }
            // 2. SE FOR ÁUDIO 🎤
            else if (message.type === 'audio') {
                textoParaIA = await transcreverAudio(message.audio.id);
            }
            // 3. SE FOR TEXTO 📝
            else if (message.type === 'text') {
                textoParaIA = message.text.body;
            }

            // SE TIVER TEXTO (Audio ou Texto Digitado), CLASSIFICA
            if (textoParaIA && !ia) {
                const txt = textoParaIA.toLowerCase();
                if (txt.includes('ativar lembretes')) { await sendMessage(from, await inscreverUsuario(from)); return res.sendStatus(200); }
                
                const cats = await getCategoriasPermitidas();
                const prompt = `Entrada: "${textoParaIA}". Data: ${getDataBrasilia()}. Categorias: [${cats}].
                Classifique JSON:
                1. REGISTRAR: {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Uma das permitidas", "item": "Nome", "valor": "0.00", "tipo": "Saída"}}
                2. CADASTRAR FIXO: {"acao": "CADASTRAR_FIXO", "dados": {"item": "Nome", "valor": "0.00", "categoria": "Uma das permitidas"}}
                3. CONSULTA (Se pedir GRÁFICO, use esta): {"acao": "CONSULTAR"}
                4. CONVERSA: {"acao": "CONVERSAR", "resposta": "..."}`;
                
                const raw = await perguntarParaGroq(prompt);
                ia = limparEConverterJSON(raw);
            }

            // --- EXECUÇÃO DO COMANDO ---
            if (ia) {
                if (ia.acao === "REGISTRAR") {
                    const salvou = await adicionarNaPlanilha(ia.dados, from);
                    if (salvou) {
                        const alerta = await verificarMeta(ia.dados.categoria, ia.dados.valor, from);
                        await sendMessage(from, `✅ *Anotado!* \n📝 ${ia.dados.item}\n💸 R$ ${ia.dados.valor} (${ia.dados.categoria})${alerta}`);
                    }
                }
                else if (ia.acao === "CADASTRAR_FIXO") {
                    await cadastrarNovoFixo(ia.dados);
                    await sendMessage(from, "📌 Fixo configurado!");
                }
                else if (ia.acao === "CONSULTAR") {
                    // SE PEDIU GRÁFICO 📊
                    if (textoParaIA && (textoParaIA.toLowerCase().includes('grafico') || textoParaIA.toLowerCase().includes('gráfico'))) {
                        const urlGrafico = await gerarGraficoPizza(from);
                        if (urlGrafico) await sendMessage(from, "Aqui está sua distribuição de gastos:", urlGrafico);
                        else await sendMessage(from, "⚠️ Não tenho dados suficientes no mês para gerar o gráfico.");
                    } else {
                        // CONSULTA TEXTO NORMAL
                        const doc = await getDoc();
                        const sheetUser = await getSheetParaUsuario(from);
                        const rows = await sheetUser.getRows({limit:20});
                        let resumo = rows.map(r => `${r.get('Data')}: ${r.get('Item/Descrição')} - R$ ${r.get('Valor')}`).join('\n');
                        const resp = await perguntarParaGroq(`Dados: ${resumo}. Pergunta: "${textoParaIA || 'Resumo'}". Responda Zap.`);
                        await sendMessage(from, resp);
                    }
                }
                else {
                    await sendMessage(from, ia.resposta || "Ok!");
                }
            }

        } catch (e) { console.error(e); }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`V12.0 Running on ${PORT}`));