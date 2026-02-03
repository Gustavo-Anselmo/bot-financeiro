const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../../google.json');
const { getDataBrasilia, getMesAnoAtual, formatarValorBRL } = require('../utils');
require('dotenv').config();

const SHEET_ID = process.env.SHEET_ID;

// Cache para evitar múltiplas autenticações
let docCache = null;
let cacheTimestamp = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// ═══════════════════════════════════════════════════════
// 🔌 CONEXÃO COM GOOGLE SHEETS
// ═══════════════════════════════════════════════════════

/**
 * Obtém instância autenticada do Google Spreadsheet (com cache)
 * @returns {Promise<GoogleSpreadsheet>}
 */
async function getDoc() {
    try {
        // Retorna cache se ainda válido
        const agora = Date.now();
        if (docCache && cacheTimestamp && (agora - cacheTimestamp) < CACHE_TTL) {
            return docCache;
        }

        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
        await doc.loadInfo();

        // Atualiza cache
        docCache = doc;
        cacheTimestamp = agora;

        console.log(`[SHEETS] Conectado: "${doc.title}"`);
        return doc;

    } catch (error) {
        console.error('[SHEETS] Erro ao conectar:', error.message);
        throw new Error('Falha ao conectar com Google Sheets');
    }
}

/**
 * Obtém ou cria a aba específica do usuário
 * @param {string} numeroUsuario - Número do WhatsApp
 * @returns {Promise<GoogleSpreadsheetWorksheet>}
 */
async function getSheetParaUsuario(numeroUsuario) {
    try {
        const doc = await getDoc();
        let sheet = doc.sheetsByTitle[numeroUsuario];

        if (!sheet) {
            console.log(`[SHEETS] Criando nova aba para ${numeroUsuario}`);
            sheet = await doc.addSheet({
                title: numeroUsuario,
                headerValues: ['Data', 'Categoria', 'Item/Descrição', 'Valor', 'Tipo']
            });
        }

        return sheet;

    } catch (error) {
        console.error('[SHEETS] Erro ao obter aba do usuário:', error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════
// 👤 GESTÃO DE USUÁRIOS
// ═══════════════════════════════════════════════════════

/**
 * Verifica se o usuário é novo (primeira interação)
 * @param {string} numero - Número do WhatsApp
 * @returns {Promise<boolean>}
 */
async function verificarUsuarioNovo(numero) {
    try {
        const doc = await getDoc();
        const sheetExtrato = doc.sheetsByTitle[numero];
        let sheetUsers = doc.sheetsByTitle['Usuarios'];

        // Verifica se tem aba de extrato
        if (sheetExtrato) return false;

        // Verifica se está cadastrado na lista de usuários
        if (sheetUsers) {
            const rows = await sheetUsers.getRows();
            const cadastrado = rows.some(r => r.get('Numero') === numero);
            if (cadastrado) return false;
        }

        return true;

    } catch (error) {
        console.error('[SHEETS] Erro ao verificar usuário novo:', error.message);
        return false;
    }
}

/**
 * Inscreve usuário para receber lembretes diários
 * @param {string} numero - Número do WhatsApp
 * @returns {Promise<string>} Mensagem de confirmação
 */
async function inscreverUsuario(numero) {
    try {
        const doc = await getDoc();
        let sheetUsers = doc.sheetsByTitle['Usuarios'];

        if (!sheetUsers) {
            sheetUsers = await doc.addSheet({
                title: 'Usuarios',
                headerValues: ['Numero', 'Ativo', 'Data_Inscricao']
            });
        }

        const rows = await sheetUsers.getRows();
        const jaInscrito = rows.find(row => row.get('Numero') === numero);

        if (jaInscrito) {
            return "⚠️ *Você já está inscrito!*\n\nSeus lembretes diários estão ativos.";
        }

        await sheetUsers.addRow({
            'Numero': numero,
            'Ativo': 'Sim',
            'Data_Inscricao': getDataBrasilia()
        });

        return "🔔 *Lembretes Ativados!*\n\n" +
               "Você receberá notificações diárias às 09:40 " +
               "para manter seu controle financeiro impecável. 📊";

    } catch (error) {
        console.error('[SHEETS] Erro ao inscrever usuário:', error.message);
        return "❌ Erro ao ativar lembretes. Tente novamente.";
    }
}

/**
 * Obtém lista de usuários ativos para envio de lembretes
 * @returns {Promise<Array<string>>}
 */
async function getUsuariosAtivos() {
    try {
        const doc = await getDoc();
        const sheetUsers = doc.sheetsByTitle['Usuarios'];

        if (!sheetUsers) return [];

        const rows = await sheetUsers.getRows();
        return rows
            .filter(r => r.get('Ativo') === 'Sim')
            .map(r => r.get('Numero'));

    } catch (error) {
        console.error('[SHEETS] Erro ao buscar usuários ativos:', error.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════
// 📂 GESTÃO DE CATEGORIAS
// ═══════════════════════════════════════════════════════

/**
 * Cria uma nova categoria na aba Metas
 * @param {string} novaCategoria - Nome da categoria
 * @returns {Promise<boolean>}
 */
async function criarNovaCategoria(novaCategoria) {
    try {
        const doc = await getDoc();
        let sheetMetas = doc.sheetsByTitle['Metas'];

        if (!sheetMetas) {
            sheetMetas = await doc.addSheet({
                title: 'Metas',
                headerValues: ['Categoria', 'Limite', 'Cor']
            });
        }

        const rows = await sheetMetas.getRows();
        const existe = rows.find(r =>
            r.get('Categoria').toLowerCase() === novaCategoria.toLowerCase()
        );

        if (existe) {
            console.log(`[SHEETS] Categoria "${novaCategoria}" já existe`);
            return false;
        }

        await sheetMetas.addRow({
            'Categoria': novaCategoria,
            'Limite': '1000.00',
            'Cor': '#4A90E2'
        });

        console.log(`[SHEETS] Categoria "${novaCategoria}" criada com sucesso`);
        return true;

    } catch (error) {
        console.error('[SHEETS] Erro ao criar categoria:', error.message);
        return false;
    }
}

/**
 * Retorna lista de categorias existentes
 * @returns {Promise<string>} String com categorias separadas por vírgula
 */
async function getCategoriasPermitidas() {
    try {
        const doc = await getDoc();
        const sheetMetas = doc.sheetsByTitle['Metas'];

        if (!sheetMetas) {
            return "Alimentação, Transporte, Lazer, Casa, Contas, Saúde, Outros";
        }

        const rows = await sheetMetas.getRows();
        const categorias = rows
            .map(row => row.get('Categoria'))
            .filter(c => c && c.trim() !== '');

        if (categorias.length === 0) {
            return "Alimentação, Transporte, Lazer, Casa, Contas, Saúde, Outros";
        }

        return categorias.join(', ');

    } catch (error) {
        console.error('[SHEETS] Erro ao buscar categorias:', error.message);
        return "Alimentação, Transporte, Lazer, Casa, Contas, Saúde, Outros";
    }
}

// ═══════════════════════════════════════════════════════
// 💾 REGISTRO E CONSULTA DE GASTOS
// ═══════════════════════════════════════════════════════

/**
 * Adiciona novo registro na planilha do usuário
 * @param {object} dados - {data, categoria, item, valor, tipo}
 * @param {string} numeroUsuario - Número do WhatsApp
 * @returns {Promise<boolean>}
 */
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

        console.log(`[SHEETS] Registro adicionado: ${dados.item} - R$ ${dados.valor}`);
        return true;

    } catch (error) {
        console.error('[SHEETS] Erro ao adicionar registro:', error.message);
        return false;
    }
}

/**
 * Verifica se o gasto ultrapassou a meta da categoria
 * @param {string} categoria - Nome da categoria
 * @param {string} valorNovo - Valor do novo gasto
 * @param {string} numeroUsuario - Número do WhatsApp
 * @returns {Promise<string>} Mensagem de alerta ou string vazia
 */
async function verificarMeta(categoria, valorNovo, numeroUsuario) {
    try {
        const doc = await getDoc();
        const sheetMetas = doc.sheetsByTitle['Metas'];

        if (!sheetMetas) return "";

        const metasRows = await sheetMetas.getRows();
        const metaRow = metasRows.find(row =>
            row.get('Categoria').toLowerCase().trim() === categoria.toLowerCase().trim()
        );

        if (!metaRow) return "";

        const limiteStr = metaRow.get('Limite');
        const limite = parseFloat(limiteStr.replace('R$', '').replace(',', '.'));

        // Busca gastos do mês atual na categoria
        const sheetUser = await getSheetParaUsuario(numeroUsuario);
        const gastosRows = await sheetUser.getRows();
        const mesAtual = getMesAnoAtual();

        let totalGastoMes = 0;

        gastosRows.forEach(row => {
            const dataRow = row.get('Data');
            const catRow = row.get('Categoria');
            const tipoRow = row.get('Tipo');

            if (dataRow.includes(mesAtual) &&
                catRow.toLowerCase().trim() === categoria.toLowerCase().trim() &&
                tipoRow === 'Saída') {
                const valor = parseFloat(row.get('Valor').replace('R$', '').replace(',', '.'));
                totalGastoMes += valor;
            }
        });

        const novoTotal = totalGastoMes + parseFloat(valorNovo);

        if (novoTotal > limite) {
            const percentual = ((novoTotal / limite) * 100).toFixed(0);
            return `\n\n🚨 *ALERTA DE META*\n` +
                   `Você ultrapassou o limite de *${categoria}*!\n` +
                   `📊 Gasto atual: ${formatarValorBRL(novoTotal)} (${percentual}% do limite)`;
        }

        // Alerta preventivo aos 80%
        if (novoTotal > limite * 0.8 && totalGastoMes <= limite * 0.8) {
            const percentual = ((novoTotal / limite) * 100).toFixed(0);
            return `\n\n⚠️ *Atenção*\n` +
                   `Você já gastou ${percentual}% do limite de *${categoria}*.\n` +
                   `Fique atento! 👀`;
        }

        return "";

    } catch (error) {
        console.error('[SHEETS] Erro ao verificar meta:', error.message);
        return "";
    }
}

// ═══════════════════════════════════════════════════════
// ✏️ EDIÇÃO E EXCLUSÃO
// ═══════════════════════════════════════════════════════

/**
 * Edita o valor de um gasto específico
 * @param {string} nomeItem - Nome do item ou "ULTIMO"
 * @param {string} novoValor - Novo valor
 * @param {string} numeroUsuario - Número do WhatsApp
 * @returns {Promise<object|false>} Objeto com dados da edição ou false
 */
async function editarUltimoGasto(nomeItem, novoValor, numeroUsuario) {
    try {
        const sheet = await getSheetParaUsuario(numeroUsuario);
        const rows = await sheet.getRows();

        if (rows.length === 0) return false;

        let rowToEdit;

        if (nomeItem === 'ULTIMO') {
            rowToEdit = rows[rows.length - 1];
        } else {
            // Busca reversa (do mais recente ao mais antigo)
            rowToEdit = rows.reverse().find(r => {
                const itemNome = r.get('Item/Descrição');
                return itemNome && itemNome.toLowerCase().includes(nomeItem.toLowerCase());
            });
        }

        if (!rowToEdit) return false;

        const valorAntigo = rowToEdit.get('Valor');
        rowToEdit.set('Valor', novoValor);
        await rowToEdit.save();

        console.log(`[SHEETS] Editado: ${rowToEdit.get('Item/Descrição')} - ${valorAntigo} → ${novoValor}`);

        return {
            item: rowToEdit.get('Item/Descrição'),
            novo_valor: novoValor,
            valor_antigo: valorAntigo
        };

    } catch (error) {
        console.error('[SHEETS] Erro ao editar gasto:', error.message);
        return false;
    }
}

/**
 * Exclui um gasto específico
 * @param {string} nomeItem - Nome do item ou "ULTIMO"
 * @param {string} numeroUsuario - Número do WhatsApp
 * @returns {Promise<object|false>} Objeto com dados do item excluído ou false
 */
async function excluirGasto(nomeItem, numeroUsuario) {
    try {
        const sheet = await getSheetParaUsuario(numeroUsuario);
        const rows = await sheet.getRows();

        if (rows.length === 0) return false;

        let rowToDelete;

        if (nomeItem === 'ULTIMO') {
            rowToDelete = rows[rows.length - 1];
        } else {
            rowToDelete = rows.reverse().find(r => {
                const itemNome = r.get('Item/Descrição');
                return itemNome && itemNome.toLowerCase().includes(nomeItem.toLowerCase());
            });
        }

        if (!rowToDelete) return false;

        const nomeRemovido = rowToDelete.get('Item/Descrição');
        const valorRemovido = rowToDelete.get('Valor');

        await rowToDelete.delete();

        console.log(`[SHEETS] Excluído: ${nomeRemovido} - ${valorRemovido}`);

        return {
            item: nomeRemovido,
            valor: valorRemovido
        };

    } catch (error) {
        console.error('[SHEETS] Erro ao excluir gasto:', error.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════════
// 📌 GASTOS FIXOS
// ═══════════════════════════════════════════════════════

/**
 * Cadastra novo gasto fixo recorrente
 * @param {object} dados - {item, valor, categoria}
 * @returns {Promise<boolean>}
 */
async function cadastrarNovoFixo(dados) {
    try {
        const doc = await getDoc();
        let sheetFixos = doc.sheetsByTitle['Fixos'];

        if (!sheetFixos) {
            sheetFixos = await doc.addSheet({
                title: 'Fixos',
                headerValues: ['Item', 'Valor', 'Categoria', 'Ativo']
            });
        }

        await sheetFixos.addRow({
            'Item': dados.item,
            'Valor': dados.valor,
            'Categoria': dados.categoria,
            'Ativo': 'Sim'
        });

        console.log(`[SHEETS] Fixo cadastrado: ${dados.item} - R$ ${dados.valor}`);
        return true;

    } catch (error) {
        console.error('[SHEETS] Erro ao cadastrar fixo:', error.message);
        return false;
    }
}

/**
 * Lança todos os gastos fixos no extrato do usuário
 * @param {string} numeroUsuario - Número do WhatsApp
 * @returns {Promise<string>} Mensagem com resumo
 */
async function lancarGastosFixos(numeroUsuario) {
    try {
        const doc = await getDoc();
        const sheetFixos = doc.sheetsByTitle['Fixos'];

        if (!sheetFixos) {
            return "⚠️ *Atenção*\n\nVocê ainda não tem gastos fixos cadastrados.\n\n" +
                   "Use: _\"Cadastrar fixo [nome] [valor]\"_";
        }

        const rowsFixos = await sheetFixos.getRows();
        const fixosAtivos = rowsFixos.filter(r => r.get('Ativo') === 'Sim');

        if (fixosAtivos.length === 0) {
            return "⚠️ *Lista Vazia*\n\nSua lista de gastos fixos está vazia.";
        }

        const sheetUser = await getSheetParaUsuario(numeroUsuario);
        const dataHoje = getDataBrasilia();
        let total = 0;
        let resumo = "";

        for (const row of fixosAtivos) {
            const item = row.get('Item');
            const valor = row.get('Valor');
            const cat = row.get('Categoria');

            await sheetUser.addRow({
                'Data': dataHoje,
                'Categoria': cat,
                'Item/Descrição': item,
                'Valor': valor,
                'Tipo': 'Saída'
            });

            total += parseFloat(valor.replace('R$', '').replace(',', '.'));
            resumo += `▪️ ${item}: R$ ${valor}\n`;
        }

        return `✅ *Lançamento Mensal Concluído*\n\n${resumo}\n` +
               `💰 *Total Lançado:* ${formatarValorBRL(total)}\n\n` +
               `📊 Seus gastos fixos foram adicionados ao extrato de ${getMesAnoAtual()}.`;

    } catch (error) {
        console.error('[SHEETS] Erro ao lançar fixos:', error.message);
        return "❌ Erro técnico ao lançar fixos. Tente novamente.";
    }
}

// ═══════════════════════════════════════════════════════
// 📊 VISUALIZAÇÃO E ANÁLISE
// ═══════════════════════════════════════════════════════

/**
 * Gera URL de gráfico de pizza com gastos por categoria
 * @param {string} numeroUsuario - Número do WhatsApp
 * @returns {Promise<string|null>} URL do gráfico ou null
 */
async function gerarGraficoPizza(numeroUsuario) {
    try {
        const sheetUser = await getSheetParaUsuario(numeroUsuario);
        const rows = await sheetUser.getRows({ limit: 200 });
        const mesAtual = getMesAnoAtual();

        const gastosPorCat = {};

        rows.forEach(row => {
            const data = row.get('Data');
            const tipo = row.get('Tipo');

            if (data && data.includes(mesAtual) && tipo === 'Saída') {
                const cat = row.get('Categoria');
                const valorStr = row.get('Valor');
                const val = parseFloat(valorStr.replace('R$', '').replace(',', '.'));

                if (!gastosPorCat[cat]) {
                    gastosPorCat[cat] = 0;
                }
                gastosPorCat[cat] += val;
            }
        });

        if (Object.keys(gastosPorCat).length === 0) return null;

        const chartConfig = {
            type: 'pie',
            data: {
                labels: Object.keys(gastosPorCat),
                datasets: [{
                    data: Object.values(gastosPorCat),
                    backgroundColor: [
                        '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0',
                        '#9966FF', '#FF9F40', '#FF6384', '#C9CBCF'
                    ]
                }]
            },
            options: {
                title: {
                    display: true,
                    text: `Gastos por Categoria - ${mesAtual}`,
                    fontSize: 16,
                    fontColor: '#333'
                },
                legend: {
                    position: 'bottom'
                },
                plugins: {
                    datalabels: {
                        color: 'white',
                        font: {
                            weight: 'bold',
                            size: 12
                        },
                        formatter: (value, ctx) => {
                            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((value / total) * 100).toFixed(1);
                            return `${percentage}%`;
                        }
                    }
                }
            }
        };

        const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=600&h=400&bkg=white`;
        return url;

    } catch (error) {
        console.error('[SHEETS] Erro ao gerar gráfico:', error.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════
module.exports = {
    getDoc,
    getSheetParaUsuario,
    verificarUsuarioNovo,
    inscreverUsuario,
    getUsuariosAtivos,
    getCategoriasPermitidas,
    criarNovaCategoria,
    adicionarNaPlanilha,
    verificarMeta,
    editarUltimoGasto,
    excluirGasto,
    cadastrarNovoFixo,
    lancarGastosFixos,
    gerarGraficoPizza
};