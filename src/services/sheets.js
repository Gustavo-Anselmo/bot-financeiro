// src/services/sheets.js
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../../google.json'); 
const { getDataBrasilia, getMesAnoAtual } = require('../utils');
require('dotenv').config();

const SHEET_ID = process.env.SHEET_ID;

// --- CONFIGURAÇÃO DA PLANILHA ---
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
    if (!sheet) sheet = await doc.addSheet({ title: numeroUsuario, headerValues: ['Data', 'Categoria', 'Item/Descrição', 'Valor', 'Tipo'] });
    return sheet;
}

// --- CATEGORIAS E METAS ---
async function criarNovaCategoria(novaCategoria) {
    try {
        const doc = await getDoc();
        let sheetMetas = doc.sheetsByTitle['Metas'];
        if (!sheetMetas) sheetMetas = await doc.addSheet({ title: 'Metas', headerValues: ['Categoria', 'Limite'] });
        
        const rows = await sheetMetas.getRows();
        const existe = rows.find(r => r.get('Categoria').toLowerCase() === novaCategoria.toLowerCase());
        if (existe) return false;

        await sheetMetas.addRow({ 'Categoria': novaCategoria, 'Limite': 'R$ 1000,00' });
        return true;
    } catch (error) { return false; }
}

async function getCategoriasPermitidas() {
    try {
        const doc = await getDoc();
        const sheetMetas = doc.sheetsByTitle['Metas'];
        if (!sheetMetas) return "Alimentação, Transporte, Lazer, Casa, Contas, Outros";
        const rows = await sheetMetas.getRows();
        const categorias = rows.map(row => row.get('Categoria')).filter(c => c);
        if (categorias.length === 0) return "Alimentação, Transporte, Lazer, Casa, Contas, Outros";
        return categorias.join(', ');
    } catch (e) { return "Alimentação, Transporte, Lazer, Casa, Contas, Outros"; }
}

// --- USUÁRIOS E FIXOS ---
async function inscreverUsuario(numero) {
    const doc = await getDoc();
    let sheetUsers = doc.sheetsByTitle['Usuarios'];
    if (!sheetUsers) sheetUsers = await doc.addSheet({ title: 'Usuarios', headerValues: ['Numero', 'Ativo'] });
    const rows = await sheetUsers.getRows();
    if (rows.find(row => row.get('Numero') === numero)) return "✅ Já está ativo!";
    await sheetUsers.addRow({ 'Numero': numero, 'Ativo': 'Sim' });
    return "🔔 Notificações Ativadas!";
}

async function cadastrarNovoFixo(dados) {
    const doc = await getDoc();
    let sheetFixos = doc.sheetsByTitle['Fixos'];
    if (!sheetFixos) sheetFixos = await doc.addSheet({ title: 'Fixos', headerValues: ['Item', 'Valor', 'Categoria'] });
    await sheetFixos.addRow({ 'Item': dados.item, 'Valor': dados.valor, 'Categoria': dados.categoria });
    return true;
}

// 🚨 A FUNÇÃO QUE TINHA SUMIDO FOI RESTAURADA AQUI 👇
async function lancarGastosFixos(numeroUsuario) {
    try {
        const doc = await getDoc();
        const sheetFixos = doc.sheetsByTitle['Fixos'];
        if (!sheetFixos) return "⚠️ Você ainda não cadastrou fixos.";
        
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
            
            total += parseFloat(valor.replace('R$', '').replace(',', '.'));
            resumo += `▪️ ${item} (R$ ${valor})\n`;
        }
        return `✅ *Fixos lançados com sucesso!*\n\n${resumo}\n💰 Total: R$ ${total.toFixed(2)}`;
    } catch (e) { 
        console.error(e);
        return "❌ Erro ao lançar fixos."; 
    }
}

// --- REGISTROS E CONSULTAS ---
async function adicionarNaPlanilha(dados, numeroUsuario) {
    const sheet = await getSheetParaUsuario(numeroUsuario);
    await sheet.addRow({ 'Data': dados.data, 'Categoria': dados.categoria, 'Item/Descrição': dados.item, 'Valor': dados.valor, 'Tipo': dados.tipo });
    return true;
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
        if ((totalGastoMes + parseFloat(valorNovo)) > limite) return `\n\n🚨 *META ESTOURADA!*`;
        return "";
    } catch (e) { return ""; }
}

async function gerarGraficoPizza(numeroUsuario) {
    try {
        const sheetUser = await getSheetParaUsuario(numeroUsuario);
        const rows = await sheetUser.getRows({ limit: 100 });
        const mesAtual = getMesAnoAtual();
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
        const chartConfig = {
            type: 'pie',
            data: { labels: Object.keys(gastosPorCat), datasets: [{ data: Object.values(gastosPorCat) }] },
            options: { title: { display: true, text: `Gastos ${mesAtual}` }, plugins: { datalabels: { color: 'white', font: { weight: 'bold' } } } }
        };
        return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=300`;
    } catch (e) { return null; }
}

async function getUsuariosAtivos() {
    try {
        const doc = await getDoc();
        const sheetUsers = doc.sheetsByTitle['Usuarios'];
        if (!sheetUsers) return [];
        const rows = await sheetUsers.getRows();
        return rows.filter(r => r.get('Ativo') === 'Sim').map(r => r.get('Numero'));
    } catch (e) { return []; }
}

module.exports = { 
    getDoc, getSheetParaUsuario, getCategoriasPermitidas, criarNovaCategoria, inscreverUsuario, 
    adicionarNaPlanilha, cadastrarNovoFixo, lancarGastosFixos, verificarMeta, gerarGraficoPizza, getUsuariosAtivos 
};