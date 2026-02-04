const express = require('express');
const cron = require('node-cron');
const { getDataBrasilia, limparEConverterJSON, formatarRespostaWhatsApp } = require('./src/utils');
const { sendMessage, markMessageAsRead } = require('./src/services/whatsapp');
const { perguntarParaGroq, transcreverAudio, analisarImagemComVision } = require('./src/services/ai');
const sheets = require('./src/services/sheets');
const { MENU_AJUDA } = require('./src/config/mensagens');
const {
    processarRegistro,
    processarSugestaoCategoria,
    processarEdicao,
    processarExclusao,
    processarCadastroFixo,
    processarConsulta
} = require('./src/handlers/processadores');
require('dotenv').config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.MY_TOKEN;

// 🗂️ ARMAZENAMENTO TEMPORÁRIO DE REGISTROS PENDENTES
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

// 🏥 HEALTH CHECK
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
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

    if (!body.object || !body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        return res.sendStatus(200);
    }

    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;

    console.log(`\n[MSG] Nova mensagem de ${from} (Tipo: ${message.type})`);

    try {
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
                    await sendMessage(from, `✅ *Categoria ${nomeCategoria} criada!*`);
                    
                    const pendente = registrosPendentes.get(from);
                    if (pendente) {
                        console.log('[PENDENTE] Processando registro com nova categoria:', pendente);
                        
                        pendente.dados.categoria = nomeCategoria;
                        await processarRegistro(pendente, from);
                        registrosPendentes.delete(from);
                    }
                } else {
                    await sendMessage(from, `⚠️ A categoria *${nomeCategoria}* já existe.`);
                }
            } 
            // ✅ CANCELAR CRIAÇÃO - SALVA EM "OUTROS"
            else if (idBotao === 'CANCELAR_CRIACAO') {
                const pendente = registrosPendentes.get(from);
                
                if (pendente && pendente.dados) {
                    console.log('[CANCELAR] Salvando em "Outros":', pendente.dados);
                    
                    // ✅ CORREÇÃO CRÍTICA: Garantir que todos os dados estão completos
                    pendente.dados.categoria = "Outros";
                    
                    // ✅ NOVO: Garantir que data e tipo estão presentes
                    if (!pendente.dados.data) {
                        pendente.dados.data = getDataBrasilia();
                    }
                    if (!pendente.dados.tipo) {
                        pendente.dados.tipo = "Saída"; // Padrão se não especificado
                    }
                    
                    await sendMessage(from, "📝 Ok! Salvando em *Outros*...");
                    await processarRegistro(pendente, from);
                    registrosPendentes.delete(from);
                } else {
                    await sendMessage(
                        from, 
                        "❌ *Operação Cancelada.*\n\n" +
                        "Não encontrei registro pendente."
                    );
                }
            }
            else if (idBotao.startsWith('CONFIRMAR_REGISTRO_')) {
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
        // 🎥 PROCESSAMENTO DE MÍDIA
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
                    "• Certifique-se que o valor está visível"
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
                    "• Enviar como texto"
                );
                return res.sendStatus(200);
            }
        } 
        else if (message.type === 'text') {
            textoParaIA = message.text.body;
        } 
        else {
            await sendMessage(
                from,
                "⚠️ *Tipo de mensagem não suportado.*\n\n" +
                "Envie: texto, áudio ou imagem."
            );
            return res.sendStatus(200);
        }

        // ═══════════════════════════════════════════════════════
        // 🧠 PROCESSAMENTO INTELIGENTE (IA)
        // ═══════════════════════════════════════════════════════
        
        if (!ia && textoParaIA) {
            console.log(`[IA] Enviando para processamento: "${textoParaIA.substring(0, 100)}"`);

            const txtLower = textoParaIA.toLowerCase();

            // Menu / Ajuda
            if (txtLower.match(/\b(ajuda|menu|help|inicio|começar)\b/)) {
                await sendMessage(from, MENU_AJUDA);
                return res.sendStatus(200);
            }

            // Ativar Lembretes (aceita singular e plural)
            if (txtLower.match(/\bativar lembrete[s]?\b/)) {
                const msg = await sheets.inscreverUsuario(from);
                await sendMessage(from, msg);
                return res.sendStatus(200);
            }

            // Desativar Lembretes
            if (txtLower.match(/\bdesativar lembrete[s]?\b/)) {
                const msg = await sheets.desinscreverUsuario(from);
                await sendMessage(from, msg);
                return res.sendStatus(200);
            }

            // Ativar Alertas
            if (txtLower.includes('ativar alerta')) {
                const msg = await sheets.ativarAlertasMeta(from);
                await sendMessage(from, msg);
                return res.sendStatus(200);
            }

            // Desativar Alertas
            if (txtLower.includes('desativar alerta')) {
                const msg = await sheets.desativarAlertasMeta(from);
                await sendMessage(from, msg);
                return res.sendStatus(200);
            }

            // Lançar Fixos
            if (txtLower.match(/\blan[çc]ar fixo/)) {
                const msg = await sheets.lancarGastosFixos(from);
                await sendMessage(from, msg);
                return res.sendStatus(200);
            }

            // ✅ CORREÇÃO: Busca categorias e trata corretamente o resultado
            const categoriasResult = await sheets.getCategoriasPermitidas();
            
            // ✅ Converte para array se necessário e depois para string
            let categoriasTexto;
            if (Array.isArray(categoriasResult)) {
                categoriasTexto = categoriasResult.join(', ');
            } else if (typeof categoriasResult === 'string') {
                categoriasTexto = categoriasResult;
            } else {
                console.warn('[CATEGORIAS] Formato inesperado:', categoriasResult);
                categoriasTexto = 'Alimentação, Transporte, Saúde, Outros';
            }
            
            const dataAtual = getDataBrasilia();

            const promptCompleto = `
Data de hoje: ${dataAtual}
Categorias existentes: ${categoriasTexto}

Mensagem do usuário: "${textoParaIA}"

Analise e retorne JSON conforme instruções do system prompt.
`;

            const respostaIA = await perguntarParaGroq(promptCompleto);
            ia = limparEConverterJSON(respostaIA);

            if (!ia) {
                console.warn('[IA] Resposta inválida:', respostaIA);
                await sendMessage(
                    from,
                    "🤔 *Não entendi bem.*\n\n" +
                    "Pode reformular? Ou digite *ajuda*."
                );
                return res.sendStatus(200);
            }
        }

        // ═══════════════════════════════════════════════════════
        // 🎯 ROTEAMENTO DE AÇÕES
        // ═══════════════════════════════════════════════════════
        console.log(`[AÇÃO] ${ia.acao}`, ia.dados || ia.resposta?.substring(0, 50));

        switch (ia.acao) {
            case 'REGISTRAR':
                await processarRegistro(ia, from);
                break;

            case 'SUGERIR_CRIACAO':
                // ✅ CORREÇÃO: Armazena registro com TODOS os dados necessários
                // Garante que tipo_pendente está presente
                if (ia.dados && !ia.dados.tipo_pendente) {
                    ia.dados.tipo_pendente = "Saída"; // Padrão
                }
                
                // Converte estrutura para formato compatível com processarRegistro
                const registroPendente = {
                    acao: "REGISTRAR",
                    dados: {
                        data: ia.dados.data_pendente || getDataBrasilia(),
                        categoria: "Outros", // Será substituído se criar categoria
                        item: ia.dados.item_original,
                        valor: ia.dados.valor_pendente || "0.00",
                        tipo: ia.dados.tipo_pendente || "Saída"
                    }
                };
                
                registrosPendentes.set(from, registroPendente);
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
                const respostaConversar = formatarRespostaWhatsApp(ia.resposta || "👋 Olá! Como posso ajudar?");
                await sendMessage(from, respostaConversar);
                break;

            default:
                await sendMessage(
                    from,
                    "🤔 *Não entendi bem.*\n\n" +
                    "Pode reformular? Ou digite *ajuda*."
                );
        }

    } catch (error) {
        console.error('[ERRO GERAL]', error);
        if (from) {
            try {
                await sendMessage(
                    from,
                    "😵 *Erro inesperado!*\n\n" +
                    "Nosso sistema teve um problema. Tente novamente."
                );
            } catch (envioError) {
                console.error('[ERRO] Falha ao enviar mensagem de erro:', envioError.message);
            }
        }
    }

    res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════
// 🚀 INICIALIZAÇÃO DO SERVIDOR
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log('════════════════════════════════════════════════');
    console.log(`  🤖 Bot Financeiro V16.0 - MELHORADO`);
    console.log(`  🌐 Porta: ${PORT}`);
    console.log(`  📅 Inicializado: ${new Date().toLocaleString('pt-BR')}`);
    console.log('════════════════════════════════════════════════');
});