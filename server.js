const express = require('express');
const cron = require('node-cron');
const { getDataBrasilia, limparEConverterJSON, validarDadosRegistro, normalizarTexto } = require('./src/utils');
const { sendMessage, sendButtonMessage, markMessageAsRead } = require('./src/services/whatsapp');
const { perguntarParaGroq, transcreverAudio, analisarImagemComVision } = require('./src/services/ai');
const sheets = require('./src/services/sheets'); 
require('dotenv').config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.MY_TOKEN;

// 📋 MENU PREMIUM V14.0
const MENU_AJUDA = `👋 *Olá! Sou seu Assistente Financeiro.*

Estou aqui para organizar seu dinheiro de forma simples e inteligente.

📝 *1. Registrar Gastos*
Envie como quiser: texto, áudio ou foto.
_"Gastei 150 no mercado"_
_"Recebi 500 de pix"_
_"Paguei cinquenta na farmácia"_

✏️ *2. Edição e Controle*
Corrigir é fácil! Só pedir.
_"Mudar valor do Uber para 20"_
_"Apagar último gasto"_
_"Corrigir valor da farmácia"_

🔄 *3. Contas Fixas*
Cadastre boletos que se repetem todo mês.
_"Cadastrar fixo Aluguel 1200"_
_"Lançar fixos"_ (quando chegar o mês)

📂 *4. Categorias Inteligentes*
Eu organizo automaticamente! Se precisar criar nova categoria, pergunto antes.

📊 *5. Consultas e Relatórios*
_"Gerar gráfico"_
_"Resumo do mês"_
_"Quanto gastei em alimentação?"_

💡 *Dica:* Digite _"Ativar lembretes"_ para receber notificações diárias às 09:40.

Como quer começar? 😊`;

// ⏰ CRON JOB - LEMBRETES DIÁRIOS
cron.schedule('40 09 * * 1-5', async () => {
    try {
        console.log('[CRON] Executando envio de lembretes...');
        const usuarios = await sheets.getUsuariosAtivos();
        
        if (usuarios.length > 0) {
            console.log(`[CRON] Enviando para ${usuarios.length} usuários`);
            
            for (const num of usuarios) {
                await sendMessage(
                    num,
                    "☀️ *Bom dia!*\n\n" +
                    "Lembrete rápido: teve algum gasto ontem ou hoje?\n\n" +
                    "Registre agora para manter o controle em dia! 📊"
                );
                // Delay para evitar rate limit
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    } catch (error) {
        console.error('[CRON] Erro ao enviar lembretes:', error);
    }
}, {
    scheduled: true,
    timezone: "America/Sao_Paulo"
});

// 🔐 WEBHOOK VERIFICATION
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === MY_TOKEN) {
        console.log('[WEBHOOK] Verificação bem-sucedida');
        res.status(200).send(challenge);
    } else {
        console.warn('[WEBHOOK] Verificação falhou');
        res.sendStatus(403);
    }
});

// 📨 WEBHOOK - RECEBER MENSAGENS
app.post('/webhook', async (req, res) => {
    const body = req.body;

    // Valida estrutura da requisição
    if (!body.object || !body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        return res.sendStatus(200);
    }

    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;

    console.log(`\n[MSG] Nova mensagem de ${from} (Tipo: ${message.type})`);

    try {
        // Marca como lida
        await markMessageAsRead(message.id);

        let textoParaIA = null;
        let ia = null;

        // ═══════════════════════════════════════════════════════
        // 🔘 TRATAMENTO DE BOTÕES INTERATIVOS
        // ═══════════════════════════════════════════════════════
        if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
            const idBotao = message.interactive.button_reply.id;
            console.log(`[BOTÃO] Ação: ${idBotao}`);

            if (idBotao.startsWith('CRIAR_')) {
                const nomeCategoria = idBotao.replace('CRIAR_', '');
                await sendMessage(from, `🔄 Criando categoria *${nomeCategoria}*...`);
                
                const criou = await sheets.criarNovaCategoria(nomeCategoria);
                
                if (criou) {
                    await sendMessage(from, `✅ *Categoria Criada!*\n\nAgora você pode usar *${nomeCategoria}* nos seus registros.`);
                } else {
                    await sendMessage(from, `⚠️ A categoria *${nomeCategoria}* já existe na sua planilha.`);
                }
            } 
            else if (idBotao === 'CANCELAR_CRIACAO') {
                await sendMessage(from, "❌ *Operação Cancelada.*\n\nVocê pode registrar o gasto manualmente ou escolher outra categoria.");
            }
            else if (idBotao.startsWith('CONFIRMAR_REGISTRO_')) {
                // Futura funcionalidade: confirmar registros pendentes
                await sendMessage(from, "⚠️ Função em desenvolvimento.");
            }

            return res.sendStatus(200);
        }

        // ═══════════════════════════════════════════════════════
        // 👤 VERIFICAÇÃO DE USUÁRIO NOVO
        // ═══════════════════════════════════════════════════════
        const isNovo = await sheets.verificarUsuarioNovo(from);
        if (isNovo) {
            console.log(`[NOVO] Usuário ${from} detectado como novo`);
            await sheets.getSheetParaUsuario(from);
            await sendMessage(from, MENU_AJUDA);
            return res.sendStatus(200);
        }

        // ═══════════════════════════════════════════════════════
        // 🎥 PROCESSAMENTO DE MÍDIA (IMAGEM/ÁUDIO)
        // ═══════════════════════════════════════════════════════
        if (message.type === 'image') {
            console.log('[IMAGEM] Processando...');
            await sendMessage(from, "📸 *Imagem recebida!* Analisando...");
            
            ia = await analisarImagemComVision(message.image.id);
            
            if (!ia || ia.acao === 'CONVERSAR') {
                await sendMessage(
                    from,
                    "⚠️ *Não consegui ler a imagem.*\n\n" +
                    "Dicas:\n" +
                    "• Tire uma foto mais nítida\n" +
                    "• Certifique-se que o valor está visível\n" +
                    "• Evite reflexos ou sombras"
                );
                return res.sendStatus(200);
            }
        } 
        else if (message.type === 'audio') {
            console.log('[ÁUDIO] Processando...');
            await sendMessage(from, "🎤 *Áudio recebido!* Transcrevendo...");
            
            try {
                textoParaIA = await transcreverAudio(message.audio.id);
                console.log(`[ÁUDIO] Transcrição: "${textoParaIA}"`);
            } catch (error) {
                await sendMessage(
                    from,
                    "⚠️ *Não consegui entender o áudio.*\n\n" +
                    "Pode tentar:\n" +
                    "• Falar mais devagar\n" +
                    "• Gravar em ambiente mais silencioso\n" +
                    "• Enviar como texto"
                );
                return res.sendStatus(200);
            }
        } 
        else if (message.type === 'text') {
            textoParaIA = message.text.body;
        } 
        else {
            // Tipo não suportado
            await sendMessage(from, "⚠️ Tipo de mensagem não suportado. Envie texto, áudio ou imagem.");
            return res.sendStatus(200);
        }

        // ═══════════════════════════════════════════════════════
        // 🤖 PROCESSAMENTO DE COMANDOS E IA
        // ═══════════════════════════════════════════════════════
        if (textoParaIA && !ia) {
            const txtNormalizado = normalizarTexto(textoParaIA);
            console.log(`[TEXTO] Recebido: "${textoParaIA}"`);

            // ─────────────────────────────────────────────────────
            // 📍 COMANDOS DIRETOS (sem passar pela IA)
            // ─────────────────────────────────────────────────────
            const gatilhosMenu = /^(ajuda|menu|inicio|iniciar|oi|ola|oie|help)$/i;
            const gatilhosLembretes = /(ativar|ligar|quer) *(lembrete|notifica)/i;
            const gatilhosFixos = /(lancar|processar|adicionar) *fixos?/i;

            if (gatilhosMenu.test(txtNormalizado)) {
                await sendMessage(from, MENU_AJUDA);
                return res.sendStatus(200);
            }

            if (gatilhosLembretes.test(txtNormalizado)) {
                const resultado = await sheets.inscreverUsuario(from);
                await sendMessage(from, resultado);
                return res.sendStatus(200);
            }

            if (gatilhosFixos.test(txtNormalizado)) {
                await sendMessage(from, "🔄 *Processando seus gastos fixos...*");
                const resultado = await sheets.lancarGastosFixos(from);
                await sendMessage(from, resultado);
                return res.sendStatus(200);
            }

            // ─────────────────────────────────────────────────────
            // 🧠 CONSULTA À IA COM CONTEXTO RICO
            // ─────────────────────────────────────────────────────
            const categorias = await sheets.getCategoriasPermitidas();
            
            const promptCompleto = `
╔════════════════════════════════════════════════════╗
  CONTEXTO DO USUÁRIO
╚════════════════════════════════════════════════════╝

📅 Data Atual: ${getDataBrasilia()}
📂 Categorias Existentes: [${categorias}]
💬 Mensagem do Usuário: "${textoParaIA}"

╔════════════════════════════════════════════════════╗
  SUA MISSÃO
╚════════════════════════════════════════════════════╝

Analise a mensagem e retorne a ação apropriada em JSON puro.

🔍 DECISÕES:

1️⃣ É um GASTO ou RECEITA comum?
   → REGISTRAR (use uma categoria da lista)

2️⃣ É um gasto que NÃO se encaixa nas categorias?
   → SUGERIR_CRIACAO (crie nome curto e claro)

3️⃣ Quer CORRIGIR valor anterior?
   → EDITAR (busque o item mencionado)

4️⃣ Quer APAGAR registro?
   → EXCLUIR (busque o item ou use "ULTIMO")

5️⃣ Quer SALVAR conta recorrente?
   → CADASTRAR_FIXO (valide categoria)

6️⃣ Quer VER dados (gráfico, resumo)?
   → CONSULTAR

7️⃣ É conversa fora do escopo financeiro?
   → CONVERSAR (recuse educadamente)

╔════════════════════════════════════════════════════╗
  EXEMPLOS PARA GUIAR
╚════════════════════════════════════════════════════╝

"Gastei 50 no mercado"
→ {"acao": "REGISTRAR", "dados": {"data": "${getDataBrasilia()}", "categoria": "Alimentação", "item": "Mercado", "valor": "50.00", "tipo": "Saída"}}

"Comprei ração pro cachorro" (sem categoria "Pets")
→ {"acao": "SUGERIR_CRIACAO", "dados": {"sugestao": "Pets", "item_original": "Ração pro cachorro", "valor_pendente": "0.00", "data_pendente": "${getDataBrasilia()}"}}

"Mudar o Uber pra 25"
→ {"acao": "EDITAR", "dados": {"item": "Uber", "novo_valor": "25.00"}}

"Apagar o último"
→ {"acao": "EXCLUIR", "dados": {"item": "ULTIMO"}}

"Gerar gráfico"
→ {"acao": "CONSULTAR", "tipo": "grafico"}

"Me conta uma piada"
→ {"acao": "CONVERSAR", "resposta": "Sou focado em finanças! Que tal registrar um gasto? 😊"}

╔════════════════════════════════════════════════════╗
  RETORNE APENAS O JSON
╚════════════════════════════════════════════════════╝
`;

            console.log('[IA] Enviando para Groq...');
            const respostaIA = await perguntarParaGroq(promptCompleto);
            ia = limparEConverterJSON(respostaIA);

            if (!ia) {
                console.error('[IA] Falha ao converter JSON:', respostaIA);
                await sendMessage(
                    from,
                    "😵 *Ops!* Tive um problema para processar.\n\n" +
                    "Pode reformular sua mensagem de forma mais clara?"
                );
                return res.sendStatus(200);
            }
        }

        // ═══════════════════════════════════════════════════════
        // 📤 EXECUÇÃO DAS AÇÕES E RESPOSTAS
        // ═══════════════════════════════════════════════════════
        if (ia && ia.acao) {
            console.log(`[AÇÃO] ${ia.acao}`);

            switch (ia.acao) {
                case "REGISTRAR":
                    await processarRegistro(ia, from);
                    break;

                case "SUGERIR_CRIACAO":
                    await processarSugestaoCategoria(ia, from);
                    break;

                case "EDITAR":
                    await processarEdicao(ia, from);
                    break;

                case "EXCLUIR":
                    await processarExclusao(ia, from);
                    break;

                case "CADASTRAR_FIXO":
                    await processarCadastroFixo(ia, from);
                    break;

                case "CONSULTAR":
                    await processarConsulta(ia, from, textoParaIA);
                    break;

                case "CONVERSAR":
                    await sendMessage(from, ia.resposta || "Desculpe, não entendi. Digite *ajuda* para ver o que posso fazer.");
                    break;

                default:
                    await sendMessage(from, "⚠️ Ação não reconhecida. Digite *ajuda* para ver comandos.");
            }
        } else {
            // Fallback se nada foi processado
            await sendMessage(
                from,
                "🤔 *Não entendi bem.*\n\n" +
                "Pode reformular? Ou digite *ajuda* para ver exemplos."
            );
        }

    } catch (error) {
        console.error('[ERRO GERAL]', error);
        await sendMessage(
            from,
            "😵 *Erro inesperado!*\n\n" +
            "Nosso sistema teve um problema. Pode tentar novamente?"
        );
    }

    res.sendStatus(200);
});

// ═════════════════════════════════════════════════════════════
// 🎯 FUNÇÕES DE PROCESSAMENTO (HANDLERS)
// ═════════════════════════════════════════════════════════════

async function processarRegistro(ia, from) {
    try {
        // Valida dados antes de salvar
        const validacao = validarDadosRegistro(ia.dados);
        if (!validacao.valido) {
            await sendMessage(from, `⚠️ *Dados Incompletos*\n\n${validacao.erro}`);
            return;
        }

        const salvou = await sheets.adicionarNaPlanilha(ia.dados, from);

        if (salvou) {
            const alerta = await sheets.verificarMeta(ia.dados.categoria, ia.dados.valor, from);

            // Resposta formatada estilo "recibo"
            const emoji = ia.dados.tipo === "Entrada" ? "💰" : "💸";
            await sendMessage(
                from,
                `✅ *Registro Confirmado*\n\n` +
                `${emoji} *${ia.dados.item}*\n` +
                `💵 Valor: *R$ ${ia.dados.valor}*\n` +
                `📂 Categoria: ${ia.dados.categoria}\n` +
                `📅 Data: ${ia.dados.data}` +
                alerta
            );
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
            `🤔 *Categoria Inexistente*\n\n` +
            `O item *"${ia.dados.item_original}"* não se encaixa nas suas categorias atuais.\n\n` +
            `Deseja criar a categoria *${sugestao}*?`,
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
            `💡 *Lembre-se:* Use "Lançar fixos" todo mês para registrar automaticamente.`
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
            // Consulta textual genérica
            await sendMessage(from, "📊 *Analisando seus dados...*");
            
            const sheetUser = await sheets.getSheetParaUsuario(from);
            const rows = await sheetUser.getRows({ limit: 30 });

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

Responda de forma analítica, clara e formatada com Markdown.
Use emojis para organizar (💰 📊 📈).
Seja objetivo e dê insights úteis.
`;

            const resposta = await perguntarParaGroq(promptAnalise);
            await sendMessage(from, resposta);
        }
    } catch (error) {
        console.error('[CONSULTAR] Erro:', error);
        await sendMessage(from, "❌ Erro ao processar consulta.");
    }
}

// ═══════════════════════════════════════════════════════
// 🚀 INICIALIZAÇÃO DO SERVIDOR
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log('════════════════════════════════════════════════');
    console.log(`  🤖 Bot Financeiro V14.0 - ONLINE`);
    console.log(`  🌐 Porta: ${PORT}`);
    console.log(`  📅 Inicializado: ${new Date().toLocaleString('pt-BR')}`);
    console.log('════════════════════════════════════════════════');
});