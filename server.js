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

// 📋 MENU PREMIUM V15.0 - MELHORADO
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

🔔 *6. Alertas de Meta (Opcional)*
_"Ativar alertas"_ - Recebe aviso ao ultrapassar limites
_"Desativar alertas"_ - Controla sem notificações

💡 *Dica:* Digite _"Ativar lembretes"_ para receber notificações diárias às 09:40.

Como quer começar? 😊`;

// 🗂️ ARMAZENAMENTO TEMPORÁRIO DE REGISTROS PENDENTES
// Usado quando o usuário recusa criar categoria e queremos salvar em "Outros"
const registrosPendentes = new Map();

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

            // ✅ CRIAR CATEGORIA E PROCESSAR REGISTRO PENDENTE
            if (idBotao.startsWith('CRIAR_')) {
                const nomeCategoria = idBotao.replace('CRIAR_', '');
                await sendMessage(from, `🔄 Criando categoria *${nomeCategoria}*...`);
                
                const criou = await sheets.criarNovaCategoria(nomeCategoria);
                
                if (criou) {
                    await sendMessage(from, `✅ *Categoria ${nomeCategoria} criada com sucesso!*`);
                    
                    // ✅ NOVO: Processa o registro pendente
                    const pendente = registrosPendentes.get(from);
                    if (pendente) {
                        console.log('[PENDENTE] Processando registro que estava aguardando:', pendente);
                        
                        // Atualiza categoria para a recém-criada
                        pendente.dados.categoria = nomeCategoria;
                        
                        await processarRegistro(pendente, from);
                        registrosPendentes.delete(from);
                    }
                } else {
                    await sendMessage(from, `⚠️ A categoria *${nomeCategoria}* já existe na sua planilha.`);
                }
            } 
            // ❌ CANCELAR CRIAÇÃO - SALVA EM "OUTROS"
            else if (idBotao === 'CANCELAR_CRIACAO') {
                const pendente = registrosPendentes.get(from);
                
                if (pendente && pendente.dados) {
                    console.log('[CANCELAR] Salvando em "Outros":', pendente.dados);
                    
                    // ✅ NOVO: Salva na categoria "Outros" ao invés de cancelar
                    pendente.dados.categoria = "Outros";
                    
                    await sendMessage(from, "📝 Tudo bem! Salvando em *Outros*...");
                    await processarRegistro(pendente, from);
                    registrosPendentes.delete(from);
                } else {
                    await sendMessage(from, "❌ *Operação Cancelada.*");
                }
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
            const gatilhosMenu = /^(ajuda|menu|inicio|iniciar|oi|ola|oie|help|oii)$/i;
            const gatilhosLembretes = /(ativar|ligar|quer) *(lembrete|notifica)/i;
            const gatilhosFixos = /(lancar|processar|adicionar) *fixos?/i;
            const gatilhosAlertasAtivar = /(ativar|ligar|quero) *(alerta|meta)/i;
            const gatilhosAlertasDesativar = /(desativar|desligar|nao quero|não quero) *(alerta|meta)/i;

            if (gatilhosMenu.test(txtNormalizado)) {
                await sendMessage(from, MENU_AJUDA);
                return res.sendStatus(200);
            }

            if (gatilhosLembretes.test(txtNormalizado)) {
                const msg = await sheets.inscreverUsuario(from);
                await sendMessage(from, msg);
                return res.sendStatus(200);
            }

            // ✅ NOVO: Gerenciar alertas de meta
            if (gatilhosAlertasAtivar.test(txtNormalizado)) {
                const msg = await sheets.ativarAlertasMeta(from);
                await sendMessage(from, msg);
                return res.sendStatus(200);
            }

            if (gatilhosAlertasDesativar.test(txtNormalizado)) {
                const msg = await sheets.desativarAlertasMeta(from);
                await sendMessage(from, msg);
                return res.sendStatus(200);
            }

            if (gatilhosFixos.test(txtNormalizado)) {
                const msg = await sheets.lancarGastosFixos(from);
                await sendMessage(from, msg);
                return res.sendStatus(200);
            }

            // ─────────────────────────────────────────────────────
            // 🧠 CHAMADA DA IA
            // ─────────────────────────────────────────────────────
            const categorias = await sheets.getCategoriasPermitidas();
            const dataHoje = getDataBrasilia();

            const promptCompleto = `
Data de hoje: ${dataHoje}
Categorias disponíveis: ${categorias}

Mensagem do usuário: "${textoParaIA}"

IMPORTANTE: Se o usuário está perguntando sobre suas funções, habilidades ou o que você faz, responda de forma conversacional e amigável descrevendo suas capacidades. Use a ação CONVERSAR com uma resposta completa e empolgante!
`;

            console.log('[IA] Enviando para Groq...');
            const respostaIA = await perguntarParaGroq(promptCompleto);
            
            // ✅ VALIDAÇÃO MELHORADA DO JSON
            ia = limparEConverterJSON(respostaIA);
            
            if (!ia || !ia.acao) {
                console.error('[IA] JSON inválido recebido:', respostaIA.substring(0, 200));
                await sendMessage(
                    from,
                    "🤔 *Não entendi bem.*\n\n" +
                    "Pode reformular? Ou digite *ajuda* para ver exemplos."
                );
                return res.sendStatus(200);
            }
        }

        // ═══════════════════════════════════════════════════════
        // 🎯 EXECUÇÃO DAS AÇÕES
        // ═══════════════════════════════════════════════════════
        if (ia && ia.acao) {
            console.log(`[AÇÃO] Executando: ${ia.acao}`);

            switch (ia.acao) {
                case 'REGISTRAR':
                    await processarRegistro(ia, from);
                    break;

                case 'SUGERIR_CRIACAO':
                    // ✅ NOVO: Armazena o registro pendente
                    registrosPendentes.set(from, ia);
                    await processarSugestaoCategoria(ia, from);
                    break;

                case 'EDITAR':
                    await processarEdicao(ia, from);
                    break;

                case 'EXCLUIR':
                    await processarExclusao(ia, from);
                    break;

                case 'CADASTRAR_FIXO':
                    await processarCadastroFixo(ia, from);
                    break;

                case 'CONSULTAR':
                    await processarConsulta(ia, from, textoParaIA);
                    break;

                case 'CONVERSAR':
                    // ✅ MELHORADO: Resposta mais natural
                    if (ia.resposta) {
                        await sendMessage(from, ia.resposta);
                    } else {
                        await sendMessage(from, "🤔 Não entendi. Digite *ajuda* para ver o que posso fazer!");
                    }
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
            // ✅ MELHORADO: Verifica se o usuário quer alertas
            const alerta = await sheets.verificarMeta(ia.dados.categoria, ia.dados.valor, from);

            // ✅ MELHORADO: Formatação mais limpa
            const emoji = ia.dados.tipo === "Entrada" ? "💰" : "💸";
            let mensagem = `✅ *Registro Confirmado*\n\n` +
                `${emoji} *${ia.dados.item}*\n` +
                `💵 Valor: *R$ ${ia.dados.valor}*\n` +
                `📂 Categoria: ${ia.dados.categoria}\n` +
                `📅 Data: ${ia.dados.data}`;
            
            // Só adiciona alerta se existir
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
        
        // ✅ MELHORADO: Mensagem mais clara
        await sendButtonMessage(
            from,
            `🤔 *Categoria inexistente para "${ia.dados.item_original}"*.\n\n` +
            `Deseja criar *${sugestao}*?\n\n` +
            `Se escolher "Não", salvarei em *Outros*.`,
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
    console.log(`  🤖 Bot Financeiro V15.0 - ONLINE`);
    console.log(`  🌐 Porta: ${PORT}`);
    console.log(`  📅 Inicializado: ${new Date().toLocaleString('pt-BR')}`);
    console.log('════════════════════════════════════════════════');
});