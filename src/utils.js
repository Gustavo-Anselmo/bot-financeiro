// ═══════════════════════════════════════════════════════
// 🛠️ UTILITÁRIOS - BOT FINANCEIRO V14.0
// ═══════════════════════════════════════════════════════

/**
 * Retorna a data atual no fuso horário de Brasília
 * @returns {string} Data no formato DD/MM/AAAA
 */
function getDataBrasilia() {
    const data = new Date().toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
    return data;
}

/**
 * Retorna o mês e ano atual no formato MM/AAAA
 * @returns {string} Mês/Ano (ex: "02/2026")
 */
function getMesAnoAtual() {
    const data = getDataBrasilia();
    return data.substring(3); // Pega apenas MM/AAAA
}

/**
 * Limpa e converte texto JSON possivelmente malformado
 * Remove markdown, comments e extrai apenas o objeto JSON
 * @param {string} texto - Resposta da IA que pode conter JSON
 * @returns {object|null} Objeto JSON parseado ou null se inválido
 */
function limparEConverterJSON(texto) {
    try {
        if (!texto || typeof texto !== 'string') {
            console.warn('[JSON] Texto inválido recebido:', texto);
            return null;
        }

        // Remove markdown code blocks
        let limpo = texto.replace(/```json|```/g, "").trim();

        // Remove comentários de linha única
        limpo = limpo.replace(/\/\/.*$/gm, "");

        // Remove comentários de bloco
        limpo = limpo.replace(/\/\*[\s\S]*?\*\//g, "");

        // Localiza o primeiro { e o último }
        const inicio = limpo.indexOf('{');
        const fim = limpo.lastIndexOf('}');

        if (inicio === -1 || fim === -1 || inicio >= fim) {
            console.warn('[JSON] Estrutura JSON não encontrada:', limpo.substring(0, 100));
            return null;
        }

        // Extrai apenas o JSON
        limpo = limpo.substring(inicio, fim + 1);

        // Tenta fazer o parse
        const json = JSON.parse(limpo);

        // Validação básica da estrutura
        if (!json.acao) {
            console.warn('[JSON] Campo "acao" ausente:', json);
            return null;
        }

        return json;

    } catch (error) {
        console.error('[JSON] Erro ao parsear:', error.message);
        console.error('[JSON] Texto original:', texto?.substring(0, 200));
        return null;
    }
}

/**
 * Valida os dados de um registro antes de salvar
 * @param {object} dados - Objeto com data, categoria, item, valor, tipo
 * @returns {object} { valido: boolean, erro?: string }
 */
function validarDadosRegistro(dados) {
    if (!dados) {
        return { valido: false, erro: "Dados não fornecidos." };
    }

    // Valida data
    if (!dados.data || typeof dados.data !== 'string') {
        return { valido: false, erro: "Data inválida ou ausente." };
    }

    // Valida categoria
    if (!dados.categoria || dados.categoria.trim() === '') {
        return { valido: false, erro: "Categoria não especificada." };
    }

    // Valida item
    if (!dados.item || dados.item.trim() === '') {
        return { valido: false, erro: "Item/Descrição não pode estar vazio." };
    }

    // Valida valor
    if (!dados.valor) {
        return { valido: false, erro: "Valor não especificado." };
    }

    const valorNumerico = parseFloat(dados.valor.toString().replace(',', '.'));
    if (isNaN(valorNumerico)) {
        return { valido: false, erro: "Valor não é um número válido." };
    }

    if (valorNumerico <= 0) {
        return { valido: false, erro: "Valor deve ser maior que zero." };
    }

    if (valorNumerico > 1000000) {
        return { valido: false, erro: "Valor muito alto. Confirme se está correto." };
    }

    // Valida tipo
    if (!dados.tipo || !['Saída', 'Entrada'].includes(dados.tipo)) {
        return { valido: false, erro: "Tipo deve ser 'Saída' ou 'Entrada'." };
    }

    return { valido: true };
}

/**
 * Normaliza texto para comparação (remove acentos, converte para minúsculas)
 * @param {string} texto - Texto a ser normalizado
 * @returns {string} Texto normalizado
 */
function normalizarTexto(texto) {
    if (!texto || typeof texto !== 'string') return '';

    return texto
        .toLowerCase()
        .normalize('NFD') // Decompõe caracteres acentuados
        .replace(/[\u0300-\u036f]/g, '') // Remove diacríticos
        .trim();
}

/**
 * Formata valor monetário para exibição
 * @param {string|number} valor - Valor a ser formatado
 * @returns {string} Valor formatado (ex: "R$ 150,00")
 */
function formatarValorBRL(valor) {
    try {
        const num = typeof valor === 'string' 
            ? parseFloat(valor.replace(',', '.')) 
            : valor;

        if (isNaN(num)) return 'R$ 0,00';

        return num.toLocaleString('pt-BR', {
            style: 'currency',
            currency: 'BRL'
        });
    } catch (error) {
        return 'R$ 0,00';
    }
}

/**
 * Converte valor por extenso para número
 * @param {string} texto - Texto com valor por extenso
 * @returns {number|null} Valor numérico ou null se não encontrado
 */
function extrairValorPorExtenso(texto) {
    const mapa = {
        'zero': 0,
        'um': 1, 'uma': 1,
        'dois': 2, 'duas': 2,
        'três': 3, 'tres': 3,
        'quatro': 4,
        'cinco': 5,
        'seis': 6,
        'sete': 7,
        'oito': 8,
        'nove': 9,
        'dez': 10,
        'vinte': 20,
        'trinta': 30,
        'quarenta': 40,
        'cinquenta': 50, 'cinquentão': 50, 'cinquentao': 50,
        'sessenta': 60,
        'setenta': 70,
        'oitenta': 80,
        'noventa': 90,
        'cem': 100, 'cento': 100,
        'duzentos': 200,
        'trezentos': 300,
        'quatrocentos': 400,
        'quinhentos': 500,
        'seiscentos': 600,
        'setecentos': 700,
        'oitocentos': 800,
        'novecentos': 900,
        'mil': 1000
    };

    const txtNormalizado = normalizarTexto(texto);

    for (const [palavra, valor] of Object.entries(mapa)) {
        if (txtNormalizado.includes(palavra)) {
            return valor;
        }
    }

    return null;
}

/**
 * Valida se uma data está no formato DD/MM/AAAA
 * @param {string} data - Data a ser validada
 * @returns {boolean} true se válida
 */
function validarFormatoData(data) {
    if (!data || typeof data !== 'string') return false;

    const regex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!regex.test(data)) return false;

    const [dia, mes, ano] = data.split('/').map(Number);

    if (mes < 1 || mes > 12) return false;
    if (dia < 1 || dia > 31) return false;
    if (ano < 2000 || ano > 2100) return false;

    // Validação de dias por mês (simplificada)
    const diasPorMes = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (dia > diasPorMes[mes - 1]) return false;

    return true;
}

/**
 * Trunca texto longo para evitar mensagens muito grandes
 * @param {string} texto - Texto a ser truncado
 * @param {number} maxLength - Tamanho máximo (default: 1000)
 * @returns {string} Texto truncado
 */
function truncarTexto(texto, maxLength = 1000) {
    if (!texto || texto.length <= maxLength) return texto;
    return texto.substring(0, maxLength) + '... (texto truncado)';
}

/**
 * Detecta se o texto contém palavras-chave de entrada/receita
 * @param {string} texto - Texto a ser analisado
 * @returns {boolean} true se for entrada
 */
function detectarEntrada(texto) {
    const palavrasEntrada = [
        'recebi', 'receber', 'ganhei', 'ganho', 'salario', 'salário',
        'pix recebido', 'transferencia recebida', 'vendi', 'venda'
    ];

    const txtNormalizado = normalizarTexto(texto);
    return palavrasEntrada.some(palavra => txtNormalizado.includes(palavra));
}

/**
 * Extrai valor numérico de um texto (ex: "R$ 150,00" -> 150.00)
 * @param {string} texto - Texto contendo valor
 * @returns {string|null} Valor normalizado ou null
 */
function extrairValorNumerico(texto) {
    if (!texto) return null;

    // Remove caracteres não numéricos exceto . e ,
    const limpo = texto.replace(/[^\d.,]/g, '');

    // Substitui vírgula por ponto
    const normalizado = limpo.replace(',', '.');

    const numero = parseFloat(normalizado);
    if (isNaN(numero)) return null;

    return numero.toFixed(2);
}

/**
 * Gera um resumo estatístico de um array de valores
 * @param {Array<number>} valores - Array de valores numéricos
 * @returns {object} { total, media, maior, menor }
 */
function calcularEstatisticas(valores) {
    if (!Array.isArray(valores) || valores.length === 0) {
        return { total: 0, media: 0, maior: 0, menor: 0 };
    }

    const total = valores.reduce((acc, val) => acc + val, 0);
    const media = total / valores.length;
    const maior = Math.max(...valores);
    const menor = Math.min(...valores);

    return {
        total: parseFloat(total.toFixed(2)),
        media: parseFloat(media.toFixed(2)),
        maior: parseFloat(maior.toFixed(2)),
        menor: parseFloat(menor.toFixed(2))
    };
}

/**
 * Sleep assíncrono (para delays)
 * @param {number} ms - Milissegundos
 * @returns {Promise}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════
module.exports = {
    getDataBrasilia,
    getMesAnoAtual,
    limparEConverterJSON,
    validarDadosRegistro,
    normalizarTexto,
    formatarValorBRL,
    extrairValorPorExtenso,
    validarFormatoData,
    truncarTexto,
    detectarEntrada,
    extrairValorNumerico,
    calcularEstatisticas,
    sleep
};