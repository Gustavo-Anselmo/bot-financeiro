// server.js (Versão Debug V13.1)
const express = require('express');
const cron = require('node-cron');
const { getDataBrasilia, limparEConverterJSON } = require('./src/utils');
const { sendMessage, sendButtonMessage, markMessageAsRead } = require('./src/services/whatsapp');
const { perguntarParaGroq, transcreverAudio, analisarImagemComVision } = require('./src/services/ai');
const sheets = require('./src/services/sheets'); 
require('dotenv').config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.MY_TOKEN;

const MENU_AJUDA = `👋 *Assistente Financeiro V13.1*

*1. Registro Rápido*
_"Gastei 50 no Uber"_
_"Apagar último gasto"_
_"Mudar valor do Uber para 60"_

*2. Gestão*
_"Cadastrar fixo Aluguel 1200"_
_"Lançar fixos"_

*3. Categorias*
Eu uso botões para criar novas categorias!

*4. Consultas*
_"Gerar gráfico"_ | _"Resumo"_
_"Ativar lembretes"_`;

// CRON JOB
cron.schedule('40 09 * * 1-5', async () => {
    try {
        const usuarios = await sheets.getUsuariosAtivos();
        if (usuarios.length > 0) usuarios.forEach(num => sendMessage(num, "☀️ Bom dia! Registre seus gastos de hoje."));
    } catch (e) { console.error("Erro no Cron:", e); }
}, { scheduled: true, timezone: "America/Sao_Paulo" });

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
            await markMessageAsRead(message.id);
            let textoParaIA = null;
            let ia = null;

            // TRATAMENTO DE BOTÕES
            if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
                const idBotao = message.interactive.button_reply.id;
                if (idBotao.startsWith('CRIAR_')) {
                    const nomeCategoria = idBotao.replace('CRIAR_', '');
                    await sendMessage(from, `🔄 Criando categoria *${nomeCategoria}*...`);
                    const criou = await sheets.criarNovaCategoria(nomeCategoria);
                    if (criou) await sendMessage(from, `✅ Categoria *${nomeCategoria}* criada!`);
                    else await sendMessage(from, `⚠️ A categoria *${nomeCategoria}* já existe.`);
                } 
                else if (idBotao === 'CANCELAR_CRIACAO') {
                    await sendMessage(from, "❌ Cancelado.");
                }
                return res.sendStatus(200); 
            }

            // BOAS VINDAS
            const isNovo = await sheets.verificarUsuarioNovo(from);
            if (isNovo) {
                await sheets.getSheetParaUsuario(from); 
                await sendMessage(from, MENU_AJUDA);
                return res.sendStatus(200);
            }

            // INPUTS
            if (message.type === 'image') {
                await sendMessage(from, "📸 Processando imagem...");
                ia = await analisarImagemComVision(message.image.id);
                if (!ia) await sendMessage(from, "⚠️ Erro ao ler imagem (IA Vision falhou).");
            } else if (message.type === 'audio') {
                textoParaIA = await transcreverAudio(message.audio.id);
            } else if (message.type === 'text') {
                textoParaIA = message.text.body;
            }

            // INTELIGÊNCIA ARTIFICIAL
            if (textoParaIA && !ia) {
                const txt = textoParaIA.toLowerCase();
                const gatilhos = ['ajuda', 'menu', 'o que voce faz', 'funcoes', 'oi', 'ola'];
                
                if (gatilhos.some(g => txt.includes(g))) { await sendMessage(from, MENU_AJUDA); return res.sendStatus(200); }
                if (txt.includes('ativar lembretes')) { await sendMessage(from, await sheets.inscreverUsuario(from)); return res.sendStatus(200); }
                if (txt.includes('lancar fixos')) {
                    await sendMessage(from, "🔄 Processando fixos...");
                    await sendMessage(from, await sheets.lancarGastosFixos(from));
                    return res.sendStatus(200);
                }

                const cats = await sheets.getCategoriasPermitidas();
                
                const prompt = `
                Input: "${textoParaIA}" | Data: ${getDataBrasilia()} | Categorias: [${cats}]
                
                REGRAS:
                - Encaixa? REGISTRAR.
                - Não encaixa? SUGERIR_CRIACAO.
                - Pediu "Mudar valor"? EDITAR.
                - Pediu "Apagar"? EXCLUIR.

                JSON:
                {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Existente", "item": "Nome", "valor": "0.00", "tipo": "Saída"}}
                {"acao": "SUGERIR_CRIACAO", "dados": {"sugestao": "NomeNova", "item_original": "NomeGasto"}}
                {"acao": "EDITAR", "dados": {"item": "NomeOuULTIMO", "novo_valor": "0.00"}}
                {"acao": "EXCLUIR", "dados": {"item": "NomeOuULTIMO"}}
                {"acao": "CADASTRAR_FIXO", "dados": {"item": "Nome", "valor": "0.00", "categoria": "Uma das permitidas"}}
                {"acao": "CONSULTAR"}
                {"acao": "CONVERSAR", "resposta": "..."}
                `;
                
                console.log("Enviando para Groq..."); // LOG DE DEBUG
                const raw = await perguntarParaGroq(prompt);
                console.log("Resposta Raw Groq:", raw); // LOG DE DEBUG
                
                ia = limparEConverterJSON(raw);
            }

            // EXECUÇÃO DA AÇÃO
            if (ia) {
                if (ia.acao === "REGISTRAR") {
                    const salvou = await sheets.adicionarNaPlanilha(ia.dados, from);
                    if (salvou) {
                        const alerta = await sheets.verificarMeta(ia.dados.categoria, ia.dados.valor, from);
                        await sendMessage(from, `✅ *Registrado*\n📝 ${ia.dados.item}\n💰 R$ ${ia.dados.valor}\n📂 ${ia.dados.categoria}${alerta}`);
                    } else {
                        await sendMessage(from, "❌ Erro ao salvar na planilha (Verifique logs).");
                    }
                } 
                else if (ia.acao === "SUGERIR_CRIACAO") {
                    const sugestao = ia.dados.sugestao;
                    await sendButtonMessage(
                        from, 
                        `🤔 Categoria inexistente para *"${ia.dados.item_original}"*.\n\nDeseja criar *${sugestao}*?`,
                        [ { id: `CRIAR_${sugestao}`, title: 'Sim, Criar' }, { id: 'CANCELAR_CRIACAO', title: 'Não' } ]
                    );
                }
                else if (ia.acao === "EDITAR") {
                    const resultado = await sheets.editarUltimoGasto(ia.dados.item, ia.dados.novo_valor, from);
                    if (resultado) await sendMessage(from, `✏️ *Atualizado!*\nO item *"${resultado.item}"* agora custa *R$ ${resultado.novo_valor}*.`);
                    else await sendMessage(from, `❌ Não encontrei gasto com nome *"${ia.dados.item}"*.`);
                }
                else if (ia.acao === "EXCLUIR") {
                    const resultado = await sheets.excluirGasto(ia.dados.item, from);
                    if (resultado) await sendMessage(from, `🗑️ *Removido!*\nApaguei: *${resultado.item}* (R$ ${resultado.valor}).`);
                    else await sendMessage(from, `❌ Nada encontrado para apagar.`);
                }
                else if (ia.acao === "CADASTRAR_FIXO") {
                    await sheets.cadastrarNovoFixo(ia.dados);
                    await sendMessage(from, "📌 Fixo configurado.");
                } 
                else if (ia.acao === "CONSULTAR") {
                    if (textoParaIA && textoParaIA.toLowerCase().includes('grafico')) {
                        const url = await sheets.gerarGraficoPizza(from);
                        if (url) await sendMessage(from, "📊 *Análise:*", url);
                        else await sendMessage(from, "📉 Sem dados suficientes.");
                    } else {
                        const doc = await sheets.getDoc();
                        const sheetUser = await sheets.getSheetParaUsuario(from);
                        const rows = await sheetUser.getRows({limit:20});
                        let resumo = rows.map(r => `${r.get('Data')}: ${r.get('Item/Descrição')} - R$ ${r.get('Valor')}`).join('\n');
                        const resp = await perguntarParaGroq(`Dados:\n${resumo}\n\nPergunta: "${textoParaIA || 'Resumo'}". Responda bonito.`);
                        await sendMessage(from, resp);
                    }
                } 
                else {
                    await sendMessage(from, ia.resposta || "Não entendi.");
                }
            } else {
                // 🚨 AQUI ESTÁ A CORREÇÃO DO SILÊNCIO 🚨
                // Se a IA retornar null (erro), o bot avisa em vez de calar.
                if (textoParaIA && !ia) {
                    console.error("Erro IA: Retornou nulo ou falhou ao parsear JSON.");
                    await sendMessage(from, "😵 Tive um problema técnico na minha inteligência. Tente reformular a frase.");
                }
            }

        } catch (e) { 
            console.error("Erro Geral no Controller:", e);
            // await sendMessage(from, "❌ Erro fatal no sistema."); // Opcional: avisar usuário
        }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Servidor V13.1 (Com Logs) rodando na porta ${PORT}`));