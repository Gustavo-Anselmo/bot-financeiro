const { getDataBrasilia, validarDadosRegistro, formatarRespostaWhatsApp } = require('../utils');
const { sendMessage, sendButtonMessage } = require('../services/whatsapp');
const { perguntarParaGroq } = require('../services/ai');
const sheets = require('../services/sheets');

const LIMITE_ROWS_CONSULTA = 200;

async function processarRegistro(ia, from) {
    try {
        const validacao = validarDadosRegistro(ia.dados);
        if (!validacao.valido) {
            await sendMessage(from, `⚠️ *Dados Incompletos*\n\n${validacao.erro}\n\n💡 Por favor, envie novamente incluindo: data, item e valor.`);
            return;
        }

        const salvou = await sheets.adicionarNaPlanilha(ia.dados, from);

        if (salvou) {
            const alerta = await sheets.verificarMeta(ia.dados.categoria, ia.dados.valor, from);

            const emoji = ia.dados.tipo === "Entrada" ? "💰" : "💸";
            let mensagem = `✅ *Registro Confirmado*\n\n` +
                `${emoji} *${ia.dados.item}*\n` +
                `💵 Valor: *R$ ${ia.dados.valor}*\n` +
                `📂 Categoria: ${ia.dados.categoria}\n` +
                `📅 Data: ${ia.dados.data}`;

            if (alerta) {
                mensagem += alerta;
            }

            await sendMessage(from, mensagem);
        } else {
            await sendMessage(from, "❌ *Erro ao salvar.*\n\nTente novamente.");
        }
    } catch (error) {
        console.error('[REGISTRAR] Erro:', error);
        await sendMessage(from, "❌ Erro ao processar registro.");
    }
}

async function processarSugestaoCategoria(ia, from) {
    try {
        const sugestao = ia.dados.sugestao;

        await sendButtonMessage(
            from,
            `🤔 *Categoria inexistente para "${ia.dados.item_original}"*.\n\n` +
            `Deseja criar *${sugestao}*?\n\n` +
            `_Se escolher "Não", o registro será salvo em "Outros"._`,
            [
                { id: `CRIAR_${sugestao}`, title: '✅ Sim, Criar' },
                { id: 'CANCELAR_CRIACAO', title: '❌ Não' }
            ]
        );
    } catch (error) {
        console.error('[SUGERIR] Erro:', error);
        await sendMessage(from, "❌ Erro ao processar sugestão.");
    }
}

async function processarEdicao(ia, from) {
    try {
        const resultado = await sheets.editarUltimoGasto(
            ia.dados.item,
            ia.dados.novo_valor,
            from
        );

        if (resultado) {
            await sendMessage(
                from,
                `✏️ *Atualizado com Sucesso*\n\n` +
                `📝 Item: *${resultado.item}*\n` +
                `💵 Antigo: ~R$ ${resultado.valor_antigo}~\n` +
                `💵 Novo: *R$ ${resultado.novo_valor}*`
            );
        } else {
            await sendMessage(
                from,
                `❌ *Não Encontrado*\n\n` +
                `Não localizei nenhum gasto com *"${ia.dados.item}"* recentemente.\n\n` +
                `Verifique o nome e tente novamente.`
            );
        }
    } catch (error) {
        console.error('[EDITAR] Erro:', error);
        await sendMessage(from, "❌ Erro ao editar registro.");
    }
}

async function processarExclusao(ia, from) {
    try {
        const resultado = await sheets.excluirGasto(ia.dados.item, from);

        if (resultado) {
            await sendMessage(
                from,
                `🗑️ *Removido com Sucesso*\n\n` +
                `📝 Item: *${resultado.item}*\n` +
                `💵 Valor: *R$ ${resultado.valor}*`
            );
        } else {
            await sendMessage(
                from,
                `❌ *Não Encontrado*\n\n` +
                `Nenhum registro com esse nome foi localizado.`
            );
        }
    } catch (error) {
        console.error('[EXCLUIR] Erro:', error);
        await sendMessage(from, "❌ Erro ao excluir registro.");
    }
}

async function processarCadastroFixo(ia, from) {
    try {
        await sheets.cadastrarNovoFixo(ia.dados);
        await sendMessage(
            from,
            `📌 *Gasto Fixo Configurado*\n\n` +
            `📝 Item: *${ia.dados.item}*\n` +
            `💵 Valor: *R$ ${ia.dados.valor}*\n` +
            `📂 Categoria: ${ia.dados.categoria}\n\n` +
            `💡 *Lembre-se:* Use "Lançar fixos" todo mês.`
        );
    } catch (error) {
        console.error('[FIXO] Erro:', error);
        await sendMessage(from, "❌ Erro ao cadastrar fixo.");
    }
}

async function processarConsulta(ia, from, textoOriginal) {
    try {
        const txt = textoOriginal ? textoOriginal.toLowerCase() : '';

        if (txt.includes('grafico') || txt.includes('gráfico') || ia.tipo === 'grafico') {
            await sendMessage(from, "📊 *Gerando seu gráfico...*");
            const url = await sheets.gerarGraficoPizza(from);

            if (url) {
                await sendMessage(from, "📊 *Análise Visual do Mês*", url);
            } else {
                await sendMessage(
                    from,
                    "📉 *Dados Insuficientes*\n\n" +
                    "Você ainda não tem gastos registrados este mês.\n\n" +
                    "Comece registrando para ver análises visuais!"
                );
            }
        } else {
            await sendMessage(from, "📊 *Analisando seus dados...*");

            const sheetUser = await sheets.getSheetParaUsuario(from);
            const rows = await sheetUser.getRows({ limit: LIMITE_ROWS_CONSULTA });

            if (rows.length === 0) {
                await sendMessage(
                    from,
                    "📭 *Sem Dados*\n\n" +
                    "Você ainda não tem registros. Comece adicionando seus gastos!"
                );
                return;
            }

            let resumo = rows.map(r =>
                `${r.get('Data')}: ${r.get('Item/Descrição')} - R$ ${r.get('Valor')} (${r.get('Categoria')})`
            ).join('\n');

            const promptAnalise = `
Dados do usuário (últimos registros):
${resumo}

Pergunta: "${textoOriginal}"

REGRAS OBRIGATÓRIAS (a resposta vai para WhatsApp):
1. SEJA OBJETIVO E CURTO - no máximo 8-10 linhas. Evite textos longos.
2. Use \\n para quebra de linha (WhatsApp não interpreta Markdown).
3. Formato ideal: um título, bullet points com • ou emojis, total no final.
4. Exemplo de estrutura:
"📊 *Resumo do mês*\\n\\n• Categoria X: R$ Y\\n• Categoria Z: R$ W\\n\\n💰 Total: R$ XXX"
5. NÃO use ## ou ** excessivos. Use *só para destaque* em palavras-chave.
6. Dê UM insight breve no final (1 linha), sem enrolação.
`;

            const resposta = await perguntarParaGroq(promptAnalise);
            const respostaFormatada = formatarRespostaWhatsApp(resposta);
            await sendMessage(from, respostaFormatada);
        }
    } catch (error) {
        console.error('[CONSULTAR] Erro:', error);
        await sendMessage(from, "❌ Erro ao processar consulta.");
    }
}

module.exports = {
    processarRegistro,
    processarSugestaoCategoria,
    processarEdicao,
    processarExclusao,
    processarCadastroFixo,
    processarConsulta
};
