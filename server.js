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

// MENU PREMIUM CONSISTENTE
const MENU_AJUDA = `👋 *Olá! Sou seu Assistente Financeiro.*

Estou aqui para organizar seu dinheiro de forma simples. Veja o que posso fazer:

📝 *1. Registrar Gastos*
Envie texto, áudio ou foto.
_"Gastei 150 no mercado"_
_"Recebi 500 de pix"_

✏️ *2. Edição e Controle*
Errou? É só pedir para arrumar.
_"Mudar valor do Uber para 20"_
_"Apagar último gasto"_

🔄 *3. Contas Fixas*
Organize seus boletos mensais.
_"Cadastrar fixo Aluguel 1200"_
_"Lançar fixos"_ (para confirmar no mês)

📂 *4. Categorias Inteligentes*
Eu organizo tudo. Se a categoria não existir, eu crio para você (com botões! 🔘).

📊 *5. Consultas*
_"Gerar gráfico"_ ou _"Resumo do mês"_

🔔 *Dica:* Digite _"Ativar lembretes"_ para eu te avisar todo dia.

Como quer começar?`;

// CRON JOB
cron.schedule('40 09 * * 1-5', async () => {
    try {
        const usuarios = await sheets.getUsuariosAtivos();
        if (usuarios.length > 0) usuarios.forEach(num => sendMessage(num, "☀️ *Bom dia!*\n\nLembrete rápido: teve algum gasto ontem ou hoje? Registre agora para manter o controle em dia."));
    } catch (e) { console.error("Erro Cron:", e); }
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

            // BOTÕES
            if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
                const idBotao = message.interactive.button_reply.id;
                if (idBotao.startsWith('CRIAR_')) {
                    const nomeCategoria = idBotao.replace('CRIAR_', '');
                    await sendMessage(from, `🔄 Criando categoria *${nomeCategoria}*...`);
                    const criou = await sheets.criarNovaCategoria(nomeCategoria);
                    if (criou) await sendMessage(from, `✅ Categoria *${nomeCategoria}* criada com sucesso!`);
                    else await sendMessage(from, `⚠️ A categoria *${nomeCategoria}* já existe.`);
                } 
                else if (idBotao === 'CANCELAR_CRIACAO') {
                    await sendMessage(from, "❌ *Operação Cancelada*.");
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
                await sendMessage(from, "📸 *Imagem recebida!* Processando...");
                ia = await analisarImagemComVision(message.image.id);
                if (!ia) await sendMessage(from, "⚠️ Não consegui ler a imagem. Tente uma foto mais clara.");
            } else if (message.type === 'audio') {
                textoParaIA = await transcreverAudio(message.audio.id);
            } else if (message.type === 'text') {
                textoParaIA = message.text.body;
            }

            // IA & COMANDOS
            if (textoParaIA && !ia) {
                const txt = textoParaIA.toLowerCase();
                const gatilhos = ['ajuda', 'menu', 'o que voce faz', 'funcoes', 'oi', 'ola', 'iniciar'];
                
                if (gatilhos.some(g => txt.includes(g))) { await sendMessage(from, MENU_AJUDA); return res.sendStatus(200); }
                if (txt.includes('ativar lembretes')) { await sendMessage(from, await sheets.inscreverUsuario(from)); return res.sendStatus(200); }
                if (txt.includes('lancar fixos')) {
                    await sendMessage(from, "🔄 *Processando fixos...*");
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
                
                console.log("Enviando para Groq...");
                const raw = await perguntarParaGroq(prompt);
                ia = limparEConverterJSON(raw);
            }

            // RESPOSTAS FORMATADAS
            if (ia) {
                if (ia.acao === "REGISTRAR") {
                    const salvou = await sheets.adicionarNaPlanilha(ia.dados, from);
                    if (salvou) {
                        const alerta = await sheets.verificarMeta(ia.dados.categoria, ia.dados.valor, from);
                        // 🎨 ESTILO TICKET/RECIBO
                        await sendMessage(from, `✅ *Registro Confirmado*\n\n📝 Item: *${ia.dados.item}*\n💰 Valor: *R$ ${ia.dados.valor}*\n📂 Categoria: ${ia.dados.categoria}${alerta}`);
                    } else {
                        await sendMessage(from, "❌ Erro ao salvar na planilha.");
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
                    if (resultado) await sendMessage(from, `✏️ *Atualizado com Sucesso*\n\nItem: *${resultado.item}*\nAntigo: ~R$ ${resultado.valor_antigo}~\nNovo: *R$ ${resultado.novo_valor}*`);
                    else await sendMessage(from, `❌ Não encontrei gasto com nome *"${ia.dados.item}"* recentemente.`);
                }
                else if (ia.acao === "EXCLUIR") {
                    const resultado = await sheets.excluirGasto(ia.dados.item, from);
                    if (resultado) await sendMessage(from, `🗑️ *Removido da Planilha*\n\nItem: *${resultado.item}*\nValor: *R$ ${resultado.valor}*`);
                    else await sendMessage(from, `❌ Nada encontrado para apagar.`);
                }
                else if (ia.acao === "CADASTRAR_FIXO") {
                    await sheets.cadastrarNovoFixo(ia.dados);
                    await sendMessage(from, `📌 *Fixo Configurado*\n\nItem: *${ia.dados.item}*\nValor: *R$ ${ia.dados.valor}*\n\nLembre de usar "Lançar fixos" mensalmente.`);
                } 
                else if (ia.acao === "CONSULTAR") {
                    if (textoParaIA && textoParaIA.toLowerCase().includes('grafico')) {
                        const url = await sheets.gerarGraficoPizza(from);
                        if (url) await sendMessage(from, "📊 *Análise Visual:*", url);
                        else await sendMessage(from, "📉 Sem dados suficientes.");
                    } else {
                        const doc = await sheets.getDoc();
                        const sheetUser = await sheets.getSheetParaUsuario(from);
                        const rows = await sheetUser.getRows({limit:20});
                        let resumo = rows.map(r => `${r.get('Data')}: ${r.get('Item/Descrição')} - R$ ${r.get('Valor')}`).join('\n');
                        const resp = await perguntarParaGroq(`Dados:\n${resumo}\n\nPergunta: "${textoParaIA || 'Resumo'}". Responda de forma analítica e formatada (Markdown).`);
                        await sendMessage(from, resp);
                    }
                } 
                else {
                    await sendMessage(from, ia.resposta || "Desculpe, não entendi.");
                }
            } else {
                if (textoParaIA && !ia) {
                    console.error("Erro IA.");
                    await sendMessage(from, "😵 Tive um soluço técnico. Pode repetir?");
                }
            }

        } catch (e) { 
            console.error("Erro Geral:", e);
        }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Servidor V13.3 (Beleza + Estabilidade) rodando na porta ${PORT}`));