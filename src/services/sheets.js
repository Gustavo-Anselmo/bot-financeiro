const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../../google.json'); 
const { getDataBrasilia, getMesAnoAtual } = require('../utils');
require('dotenv').config();

const SHEET_ID = process.env.SHEET_ID;

// --- CONEXÃO ---
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

// --- BOAS VINDAS ---
async function verificarUsuarioNovo(numero) {
    try {
        const doc = await getDoc();
        const sheetExtrato = doc.sheetsByTitle[numero];
        let sheetUsers = doc.sheetsByTitle['Usuarios'];
        let cadastradoEmUsers = false;
        if (sheetUsers) {
            const rows = await sheetUsers.getRows();
            cadastradoEmUsers = rows.some(r => r.get('Numero') === numero);
        }
        if (!sheetExtrato && !cadastradoEmUsers) return true;
        return false;
    } catch (e) { return false; }
}

async function inscreverUsuario(numero) {
    const doc = await getDoc();
    let sheetUsers = doc.sheetsByTitle['Usuarios'];
    if (!sheetUsers) sheetUsers = await doc.addSheet({ title: 'Usuarios', headerValues: ['Numero', 'Ativo'] });
    const rows = await sheetUsers.getRows();
    if (rows.find(row => row.get('Numero') === numero)) return "⚠️ *Aviso:* Você já faz parte da lista VIP de lembretes.";
    await sheetUsers.addRow({ 'Numero': numero, 'Ativo': 'Sim' });
    return "🔔 *Lembretes Ativados!*\n\nAgora você receberá notificações diárias às 09:40 para manter seu controle financeiro impecável.";
}

// --- EDIÇÃO E EXCLUSÃO ---
async function editarUltimoGasto(nomeItem, novoValor, numeroUsuario) {
    try {
        const sheet = await getSheetParaUsuario(numeroUsuario);
        const rows = await sheet.getRows();
        let rowToEdit;
        if (nomeItem === 'ULTIMO') {
            rowToEdit = rows[rows.length - 1];
        } else {
            rowToEdit = rows.reverse().find(r => r.get('Item/Descrição').toLowerCase().includes(nomeItem.toLowerCase()));
        }
        if (!rowToEdit) return false;
        
        const valorAntigo = rowToEdit.get('Valor');
        rowToEdit.set('Valor', novoValor);
        await rowToEdit.save();
        
        return { item: rowToEdit.get('Item/Descrição'), novo_valor: novoValor, valor_antigo: valorAntigo };
    } catch (e) { return false; }
}

async function excluirGasto(nomeItem, numeroUsuario) {
    try {
        const sheet = await getSheetParaUsuario(numeroUsuario);
        const rows = await sheet.getRows();
        let rowToDelete;
        if (nomeItem === 'ULTIMO') {
            rowToDelete = rows[rows.length - 1];
        } else {
            rowToDelete = rows.reverse().find(r => r.get('Item/Descrição').toLowerCase().includes(nomeItem.toLowerCase()));
        }
        if (!rowToDelete) return false;
        const nomeRemovido = rowToDelete.get('Item/Descrição');
        const valorRemovido = rowToDelete.get('Valor');
        await rowToDelete.delete();
        return { item: nomeRemovido, valor: valorRemovido };
    } catch (e) { return false; }
}

// --- CATEGORIAS ---
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

// --- FIXOS ---
async function cadastrarNovoFixo(dados) {
    const doc = await getDoc();
    let sheetFixos = doc.sheetsByTitle['Fixos'];
    if (!sheetFixos) sheetFixos = await doc.addSheet({ title: 'Fixos', headerValues: ['Item', 'Valor', 'Categoria'] });
    await sheetFixos.addRow({ 'Item': dados.item, 'Valor': dados.valor, 'Categoria': dados.categoria });
    return true;
}

async function lancarGastosFixos(numeroUsuario) {
    try {
        const doc = await getDoc();
        const sheetFixos = doc.sheetsByTitle['Fixos'];
        if (!sheetFixos) return "⚠️ *Atenção:* Você ainda não tem gastos fixos cadastrados.";
        const rowsFixos = await sheetFixos.getRows();
        if (rowsFixos.length === 0) return "⚠️ *Atenção:* Sua lista de fixos está vazia.";
        
        const sheetUser = await getSheetParaUsuario(numeroUsuario);
        const dataHoje = getDataBrasilia();
        let total = 0;
        let resumo = "";
        
        for (const row of rowsFixos) {
            const item = row.get('Item');
            const valor = row.get('Valor');
            const cat = row.get('Categoria');
            await sheetUser.addRow({ 'Data': dataHoje, 'Categoria': cat, 'Item/Descrição': item, 'Valor': valor, 'Tipo': 'Saída' });
            total += parseFloat(valor.replace('R$', '').replace(',', '.'));
            resumo += `▪️ ${item}: R$ ${valor}\n`;
        }
        return `✅ *Lançamento Mensal Concluído*\n\n${resumo}\n💰 *Total Lançado:* R$ ${total.toFixed(2)}`;
    } catch (e) { return "❌ Erro técnico ao lançar fixos."; }
}

// --- REGISTRO E CONSULTA ---
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
        if ((totalGastoMes + parseFloat(valorNovo)) > limite) return `\n\n🚨 *ALERTA DE META*\nVocê ultrapassou seu limite planejado para *${categoria}*!`;
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
    adicionarNaPlanilha, cadastrarNovoFixo, lancarGastosFixos, verificarMeta, gerarGraficoPizza, getUsuariosAtivos, verificarUsuarioNovo,
    editarUltimoGasto, excluirGasto 
};