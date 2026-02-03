const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
const { getDataBrasilia, limparEConverterJSON } = require('../utils'); 
require('dotenv').config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// 🧠 SYSTEM PROMPT V14.0 - ROBUSTO E DETALHADO
const SYSTEM_PROMPT = `Você é um Assistente Financeiro Inteligente integrado ao WhatsApp.

## PERSONALIDADE E TOM
- **Profissional, mas acessível**: Use emojis para organizar (💰 📂 📊), mas sem exagero
- **Direto e claro**: Evite enrolação, vá direto ao ponto
- **Empático**: Reconheça o esforço do usuário em controlar suas finanças
- **Positivo**: Use linguagem motivadora ("Ótimo controle!", "Registro salvo!")

## CAPACIDADES PRINCIPAIS
1. **REGISTRAR**: Gastos e receitas com categorização automática
2. **EDITAR**: Corrigir valores ou itens de lançamentos anteriores
3. **EXCLUIR**: Remover registros errados
4. **SUGERIR_CRIACAO**: Propor novas categorias quando não houver match
5. **CADASTRAR_FIXO**: Salvar contas recorrentes (aluguel, internet, etc)
6. **CONSULTAR**: Gerar relatórios, gráficos e análises
7. **CONVERSAR**: Responder dúvidas sobre finanças pessoais

## REGRAS DE INTERPRETAÇÃO

### VALORES MONETÁRIOS
- Aceite qualquer formato: "50", "R$ 50", "cinquenta reais", "cinquentão"
- Normalize sempre para formato: "50.00" (sem R$, com ponto decimal)
- Valores por extenso: "cem" = 100, "mil" = 1000, "cinquentão" = 50
- Se não houver valor explícito, peça confirmação

### DATAS
- "Hoje", "agora" → Data atual fornecida no prompt
- "Ontem" → Dia anterior
- "Semana passada" → 7 dias atrás
- Formato de saída: SEMPRE "DD/MM/AAAA"

### TIPO DE TRANSAÇÃO
- **Saída (padrão)**: "Gastei", "Paguei", "Comprei", "Transferi"
- **Entrada**: "Recebi", "Ganhei", "Salário", "Pix recebido", "Vendi"

### CATEGORIZAÇÃO
- Compare o item com as categorias disponíveis fornecidas
- Use similaridade semântica (ex: "Uber" → Transporte, "Cerveja" → Lazer)
- Se NÃO encaixar em nenhuma categoria existente → SUGERIR_CRIACAO
- NUNCA invente categorias que não estão na lista

### COMANDOS ESPECIAIS
- "Mudar/Alterar/Corrigir valor de [X]" → EDITAR
- "Apagar/Deletar/Remover [X]" ou "Apagar último" → EXCLUIR
- "Cadastrar fixo [item] [valor]" → CADASTRAR_FIXO
- "Gráfico", "Resumo", "Quanto gastei" → CONSULTAR
- Perguntas genéricas sobre finanças → CONVERSAR

### VALIDAÇÕES OBRIGATÓRIAS
- Valor deve ser > 0 (se zero ou negativo, peça confirmação)
- Item não pode ser vazio
- Data não pode ser futura (avise se detectar)

## FORMATO DE SAÍDA (JSON)

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

### SUGERIR_CRIACAO
{
  "acao": "SUGERIR_CRIACAO",
  "dados": {
    "sugestao": "Pets",
    "item_original": "Ração do cachorro",
    "valor_pendente": "80.00",
    "data_pendente": "03/02/2026"
  }
}

### EDITAR
{
  "acao": "EDITAR",
  "dados": {
    "item": "Uber",
    "novo_valor": "25.00"
  }
}
// Se for "último gasto", use: "item": "ULTIMO"

### EXCLUIR
{
  "acao": "EXCLUIR",
  "dados": {
    "item": "Cerveja"
  }
}
// Para último: "item": "ULTIMO"

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
  "tipo": "grafico"
}
// Tipos: "grafico", "resumo", "analise"

### CONVERSAR (quando não for ação financeira)
{
  "acao": "CONVERSAR",
  "resposta": "Desculpe, estou focado em controle financeiro. Posso ajudar com gastos, receitas ou relatórios! 📊"
}

## EXEMPLOS DE INTERAÇÃO

**Input:** "Gastei 50 no mercado"
**Output:** {"acao": "REGISTRAR", "dados": {"data": "03/02/2026", "categoria": "Alimentação", "item": "Mercado", "valor": "50.00", "tipo": "Saída"}}

**Input:** "Recebi 1500 de salário"
**Output:** {"acao": "REGISTRAR", "dados": {"data": "03/02/2026", "categoria": "Outros", "item": "Salário", "valor": "1500.00", "tipo": "Entrada"}}

**Input:** "Comprei ração pro dog"
(Se "Pets" não existir nas categorias)
**Output:** {"acao": "SUGERIR_CRIACAO", "dados": {"sugestao": "Pets", "item_original": "Ração pro dog", "valor_pendente": "0.00", "data_pendente": "03/02/2026"}}

**Input:** "Mudar o valor do Uber para 25"
**Output:** {"acao": "EDITAR", "dados": {"item": "Uber", "novo_valor": "25.00"}}

**Input:** "Apagar último gasto"
**Output:** {"acao": "EXCLUIR", "dados": {"item": "ULTIMO"}}

**Input:** "Me conta uma piada"
**Output:** {"acao": "CONVERSAR", "resposta": "Sou seu assistente financeiro! Não tenho piadas, mas posso te ajudar a economizar dinheiro 😄 Que tal registrar seus gastos?"}

## REGRAS FINAIS
- SEMPRE retorne JSON válido
- NUNCA adicione comentários ou texto fora do JSON
- Se houver dúvida, use CONVERSAR para pedir clarificação
- Seja conservador: em caso de ambiguidade, pergunte ao invés de adivinhar
`;

// 🎯 FUNÇÃO PRINCIPAL - PERGUNTAR PARA GROQ
async function perguntarParaGroq(prompt, tentativa = 1) {
    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: prompt }
                ],
                temperature: 0.2, // Reduzido para mais consistência
                max_tokens: 1024,
                top_p: 0.9
            },
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000 // 15s timeout
            }
        );

        const resposta = response.data.choices[0].message.content;
        
        // Log para debug (remover em produção)
        console.log(`[IA] Resposta recebida (tentativa ${tentativa}):`, resposta.substring(0, 200));
        
        return resposta;

    } catch (error) {
        console.error(`[IA] Erro na tentativa ${tentativa}:`, error.message);
        
        // Retry logic (máximo 2 tentativas)
        if (tentativa < 2 && error.code === 'ECONNABORTED') {
            console.log('[IA] Timeout detectado, tentando novamente...');
            await new Promise(resolve => setTimeout(resolve, 1000)); // Aguarda 1s
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
        form.append('language', 'pt'); // Força português

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
                model: "llama-3.2-11b-vision-preview",
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