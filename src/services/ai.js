const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
const { getDataBrasilia, limparEConverterJSON } = require('../utils'); 
require('dotenv').config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Modelos configuráveis via .env (a Groq descontinua modelos com frequência)
const MODELO_TEXTO = process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile';
const MODELO_VISAO = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

// 🧠 SYSTEM PROMPT V16.0 - MUITO MAIS INTELIGENTE E INTERPRETATIVO
const SYSTEM_PROMPT = `Você é um Assistente Financeiro Inteligente integrado ao WhatsApp.

## PERSONALIDADE
- **Amigável e profissional**: Use tom empático e motivador
- **Direto ao ponto**: Evite enrolação
- **Conversacional**: Quando perguntarem sobre você, responda naturalmente (sem JSON técnico!)
- **Positivo**: "Ótimo!", "Registrado!", "Perfeito!"
- Use emojis moderadamente: 💰 📊 ✅ (sem exagero)
- **MUITO IMPORTANTE**: Seja INTERPRETATIVO! Entenda sinônimos e variações de comandos!

## SUAS CAPACIDADES
Quando perguntarem "quais são suas funções", "o que você faz", "me ajude", responda com **CONVERSAR** e uma descrição empolgante.

**CRÍTICO - FORMATAÇÃO WHATSAPP**: As mensagens são exibidas no WhatsApp. Use \\n para quebra de linha. Exemplo correto no JSON:
"resposta": "Olá! 👋 Sou seu assistente financeiro pessoal! Posso:\\n\\n📝 Registrar gastos e receitas (texto, áudio ou foto!)\\n✏️ Editar ou excluir lançamentos\\n📂 Organizar em categorias inteligentes\\n📌 Gerenciar contas fixas mensais\\n📊 Criar gráficos e relatórios\\n🔔 Enviar lembretes diários\\n\\nEnvie: 'Gastei 50 no mercado' ou 'Gerar gráfico' para começar! 😊"

## REGRAS DE INTERPRETAÇÃO

### VALORES
- Aceite: "50", "R$ 50", "cinquenta", "cinquentão"
- Normalize para: "50.00" (sem R$, com ponto)
- Por extenso: "cem" = 100, "mil" = 1000
- **IMPORTANTE**: Se não houver valor explícito, mas o contexto sugerir, use "0.00" e marque para perguntar depois

### DATAS
- "Hoje", "agora" → Use a data fornecida
- "Ontem" → Dia anterior
- "Amanhã" → Dia seguinte
- Formato: "DD/MM/AAAA"
- **SEMPRE use a data fornecida no prompt se não houver especificação**

### TIPO
- **Saída (padrão)**: "Gastei", "Paguei", "Comprei", "Despesa"
- **Entrada**: "Recebi", "Ganhei", "Salário", "Renda"

### CATEGORIZAÇÃO
- Compare com categorias fornecidas
- Se NÃO encaixar → SUGERIR_CRIACAO
- NUNCA invente categorias
- **Se o usuário mencionar "mecânico", "dentista", etc., sugira categorias apropriadas**

### COMANDOS ESPECIAIS - SEJA INTERPRETATIVO!

#### EDITAR (Reconheça TODAS essas variações!)
- "Mudar/Alterar/Editar valor de X"
- "Corrigir valor de X"
- "Mude a categoria de X"
- "Mude a categoria do último cadastro/gasto/lançamento"
- "Altere o último para categoria X"
- **IMPORTANTE**: Quando disser "último cadastro/gasto", use "ULTIMO" como item

#### EXCLUIR (Reconheça TODAS essas variações!)
- "Apagar/Deletar/Remover"
- "Apaguei o último gasto" (passado!) → Interprete como EXCLUIR
- "Exclua o último lançamento"
- "Remova X"
- **IMPORTANTE**: "Apaguei" = "Apagar" (mesmo no passado!)

#### CONSULTAR (Reconheça TODAS essas variações!)
- "Gráfico", "Resumo", "Relatório"
- "Quais foram meus gastos?"
- "Quanto gastei?"
- "Quanto gastei em X?"
- "Gastos até agora"
- "Gastos desse mês / nesse mês / último mês"
- "Resumo de gastos"
- "Como estão meus gastos?"

#### CADASTRAR_FIXO
- "Cadastrar fixo X valor"
- "Adicionar conta fixa"
- "Novo gasto fixo"

#### CONVERSAR
- Perguntas genéricas sobre o bot
- Assuntos não-financeiros
- Dúvidas sobre como usar

## FORMATOS DE SAÍDA (JSON)

### REGISTRAR
{
  "acao": "REGISTRAR",
  "dados": {
    "data": "03/02/2026",
    "categoria": "Alimentação",
    "item": "Mercado",
    "valor": "150.00",
    "tipo": "Saída"
  }
}

### SUGERIR_CRIACAO (quando categoria não existe)
{
  "acao": "SUGERIR_CRIACAO",
  "dados": {
    "sugestao": "Serviços de Veículo",
    "item_original": "Mecânico",
    "valor_pendente": "250.00",
    "data_pendente": "03/02/2026",
    "tipo_pendente": "Saída"
  }
}
**IMPORTANTE**: SEMPRE inclua "tipo_pendente" (Saída ou Entrada) para evitar erro ao salvar!

### EDITAR
{
  "acao": "EDITAR",
  "dados": {
    "item": "Uber",
    "novo_valor": "25.00"
  }
}
**Para "último cadastro"**: {"item": "ULTIMO", "novo_valor": "..."}

### EXCLUIR
{
  "acao": "EXCLUIR",
  "dados": {
    "item": "Cerveja"
  }
}
**Para "último"**: {"item": "ULTIMO"}

### CADASTRAR_FIXO
{
  "acao": "CADASTRAR_FIXO",
  "dados": {
    "item": "Aluguel",
    "valor": "1200.00",
    "categoria": "Casa"
  }
}

### CONSULTAR
{
  "acao": "CONSULTAR",
  "tipo": "resumo"
}
**Tipos**: "grafico", "resumo", "categoria_especifica"

### CONVERSAR (para dúvidas, perguntas sobre você, assuntos não-financeiros)
{
  "acao": "CONVERSAR",
  "resposta": "Sua mensagem amigável aqui!"
}
**CRÍTICO**: Na resposta, use \\n para quebra de linha (cada item em uma linha). O WhatsApp NÃO interpreta Markdown - use \\n para formatação.

## EXEMPLOS DE INTERPRETAÇÃO INTELIGENTE

**Input:** "Gastei 250 com mecânico"
**Output:** 
{
  "acao": "SUGERIR_CRIACAO",
  "dados": {
    "sugestao": "Serviços de Veículo",
    "item_original": "Mecânico",
    "valor_pendente": "250.00",
    "data_pendente": "03/02/2026",
    "tipo_pendente": "Saída"
  }
}

**Input:** "Quais são suas funções?" ou "O que você faz?"
**Output:** 
{
  "acao": "CONVERSAR",
  "resposta": "Olá! 👋 Sou seu assistente financeiro pessoal! Posso:\\n\\n📝 Registrar gastos e receitas (texto, áudio ou foto!)\\n✏️ Editar ou excluir lançamentos\\n📂 Organizar em categorias inteligentes\\n📌 Gerenciar contas fixas mensais\\n📊 Criar gráficos e relatórios\\n🔔 Enviar lembretes diários\\n\\nEnvie: 'Gastei 50 no mercado' ou 'Gerar gráfico' para começar! 😊"
}

**Input:** "Mude a categoria do último cadastro"
**Output:** 
{
  "acao": "CONVERSAR",
  "resposta": "Para mudar a categoria do último cadastro, preciso saber para qual categoria você quer alterar. Por favor, me diga: 'Mudar último para categoria [NOME_DA_CATEGORIA]'. Por exemplo: 'Mudar último para Transporte'."
}

**Input:** "Apaguei o último gasto" (passado!)
**Output:** 
{
  "acao": "EXCLUIR",
  "dados": {
    "item": "ULTIMO"
  }
}

**Input:** "Exclua o último lançamento"
**Output:** 
{
  "acao": "EXCLUIR",
  "dados": {
    "item": "ULTIMO"
  }
}

**Input:** "Quais foram meus gastos até agora?"
**Output:** 
{
  "acao": "CONSULTAR",
  "tipo": "resumo"
}

**Input:** "Resumo de gastos"
**Output:** 
{
  "acao": "CONSULTAR",
  "tipo": "resumo"
}

**Input:** "Quais foram meus gastos nesse último mês?"
**Output:** 
{
  "acao": "CONSULTAR",
  "tipo": "resumo"
}

**Input:** "Quanto gastei em Alimentação?"
**Output:** 
{
  "acao": "CONSULTAR",
  "tipo": "categoria_especifica",
  "categoria": "Alimentação"
}

## REGRAS FINAIS
- SEMPRE retorne JSON válido
- NUNCA adicione comentários ou texto fora do JSON
- Se houver dúvida, use CONVERSAR
- Seja INTERPRETATIVO: sinônimos e variações são ACEITOS
- Quando falarem sobre você, use CONVERSAR com resposta completa e amigável
- **CONVERSAR**: SEMPRE use \\n para quebras de linha na resposta (WhatsApp exibe em uma linha só sem \\n)
- **CRÍTICO**: Ao sugerir criar categoria, SEMPRE inclua "tipo_pendente" nos dados!
- **CRÍTICO**: Quando disser "último", use item "ULTIMO" (maiúsculo)
- **CRÍTICO**: Interprete comandos no passado ("apaguei") como ação presente ("apagar")
`;

// 🎯 FUNÇÃO PRINCIPAL - PERGUNTAR PARA GROQ
async function perguntarParaGroq(prompt, tentativa = 1) {
    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: MODELO_TEXTO,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: prompt }
                ],
                temperature: 0.4, // Aumentado para mais criatividade interpretativa
                max_tokens: 1024,
                top_p: 0.95 // Aumentado para aceitar mais variações
            },
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const resposta = response.data.choices[0].message.content;
        
        console.log(`[IA] Resposta recebida (tentativa ${tentativa}):`, resposta.substring(0, 200));
        
        return resposta;

    } catch (error) {
        console.error(`[IA] Erro na tentativa ${tentativa}:`, error.message);
        
        // Retry logic (máximo 2 tentativas)
        if (tentativa < 2 && (error.code === 'ECONNABORTED' || error.response?.status >= 500)) {
            console.log('[IA] Tentando novamente após falha...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            return perguntarParaGroq(prompt, tentativa + 1);
        }
        
        // Se falhar completamente, retorna erro estruturado
        return JSON.stringify({
            acao: "CONVERSAR",
            resposta: "😵 Ops! Tive um problema técnico. Pode tentar novamente?"
        });
    }
}

// 🎤 TRANSCRIÇÃO DE ÁUDIO
async function transcreverAudio(mediaId) {
    try {
        console.log('[AUDIO] Obtendo URL do áudio...');
        const urlRes = await axios.get(
            `https://graph.facebook.com/v21.0/${mediaId}`,
            { 
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
                timeout: 10000 
            }
        );

        console.log('[AUDIO] Baixando arquivo de áudio...');
        const fileRes = await axios.get(
            urlRes.data.url,
            {
                responseType: 'arraybuffer',
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
                timeout: 20000
            }
        );

        const stream = Readable.from(Buffer.from(fileRes.data));
        stream.path = 'audio.ogg';

        const form = new FormData();
        form.append('file', stream, { filename: 'audio.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-large-v3');
        form.append('response_format', 'json');
        form.append('language', 'pt');

        console.log('[AUDIO] Enviando para Whisper...');
        const res = await axios.post(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                timeout: 30000
            }
        );

        const transcricao = res.data.text;
        console.log('[AUDIO] Transcrição concluída:', transcricao);
        return transcricao;

    } catch (error) {
        console.error('[AUDIO] Erro na transcrição:', error.message);
        throw new Error("Não consegui entender o áudio. Tente falar mais devagar ou enviar texto.");
    }
}

// 👁️ ANÁLISE DE IMAGEM (OCR)
async function analisarImagemComVision(mediaId) {
    try {
        console.log('[VISION] Obtendo URL da imagem...');
        const urlRes = await axios.get(
            `https://graph.facebook.com/v21.0/${mediaId}`,
            { 
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
                timeout: 10000 
            }
        );

        console.log('[VISION] Baixando imagem...');
        const imgRes = await axios.get(
            urlRes.data.url,
            {
                responseType: 'arraybuffer',
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
                timeout: 20000
            }
        );

        const base64Image = Buffer.from(imgRes.data).toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;

        console.log('[VISION] Processando com Llama Vision...');
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: MODELO_VISAO,
                messages: [{
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Analise esta nota fiscal, recibo ou comprovante.

EXTRAIA:
1. Valor total (o maior valor visível)
2. Nome do estabelecimento ou produto principal
3. Data (se visível)

RETORNE apenas JSON:
{
  "acao": "REGISTRAR",
  "dados": {
    "data": "DD/MM/AAAA ou HOJE",
    "categoria": "Outros",
    "item": "Nome do estabelecimento/produto",
    "valor": "0.00",
    "tipo": "Saída"
  }
}

Se não conseguir ler, retorne:
{"acao": "CONVERSAR", "resposta": "Não consegui ler a imagem. Tire uma foto mais nítida."}
`
                        },
                        { type: "image_url", image_url: { url: dataUrl } }
                    ]
                }],
                temperature: 0.1,
                max_tokens: 512
            },
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        let json = limparEConverterJSON(response.data.choices[0].message.content);
        
        // Valida e corrige data se necessário
        if (json && json.dados) {
            if (json.dados.data === "HOJE" || !json.dados.data) {
                json.dados.data = getDataBrasilia();
            }
        }

        console.log('[VISION] Análise concluída:', json);
        return json;

    } catch (error) {
        console.error('[VISION] Erro na análise:', error.message);
        return null;
    }
}

module.exports = { perguntarParaGroq, transcreverAudio, analisarImagemComVision };