// src/utils.js
function getDataBrasilia() {
    return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function getMesAnoAtual() {
    return getDataBrasilia().substring(3); 
}

function limparEConverterJSON(texto) {
    try {
        let limpo = texto.replace(/```json|```/g, "").trim();
        const inicio = limpo.indexOf('{');
        const fim = limpo.lastIndexOf('}');
        if (inicio !== -1 && fim !== -1) {
            limpo = limpo.substring(inicio, fim + 1);
        }
        return JSON.parse(limpo);
    } catch (e) {
        return null;
    }
}

module.exports = { getDataBrasilia, getMesAnoAtual, limparEConverterJSON };