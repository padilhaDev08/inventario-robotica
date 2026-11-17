import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chaveEntrada,
  chavePosicao,
  escolherFoto,
  interpretarLocal,
  nomeCategoria,
  nomePosicao,
} from "../scripts/importar-coleta-regras.mjs";

const arm = (numero, detalhe) => ({ grupo: "armario", numero, detalhe });

test("local: armário e prateleira com gaveta escrita de jeitos diferentes", () => {
  assert.deepEqual(interpretarLocal("ARMARIO 4 PRATELEIRA 1 GV-16"), arm(4, "Prateleira 1, Gaveta 16"));
  assert.deepEqual(interpretarLocal("ARMARIO 4 PRATELEIRA 1 GV- 10"), arm(4, "Prateleira 1, Gaveta 10"));
  assert.deepEqual(interpretarLocal("ARMARIO 4 PRATELEIRA 1 GV 02"), arm(4, "Prateleira 1, Gaveta 2"));
  assert.deepEqual(interpretarLocal("ARMARIO 4, PRATELEIRA 1, GAVETA 13"), arm(4, "Prateleira 1, Gaveta 13"));
  assert.deepEqual(interpretarLocal("ARMARIO 4 ,PRATELEIRA 1, GAVETA 12"), arm(4, "Prateleira 1, Gaveta 12"));
});

test("local: erros de digitação e número solto", () => {
  assert.deepEqual(interpretarLocal("ARMRAIO 4 PRALEIRA 1 GV-017"), arm(4, "Prateleira 1, Gaveta 17"));
  assert.deepEqual(interpretarLocal("ARMARIO 4 PRETELEIRA 1"), arm(4, "Prateleira 1"));
  assert.deepEqual(interpretarLocal("ARMARIO 4, PRATELEIRA 1, 13"), arm(4, "Prateleira 1, Gaveta 13"));
});

test("local: várias gavetas, caixas, gaveteiro e posição", () => {
  assert.deepEqual(interpretarLocal("ARMARIO 4, PRATELEIRA 1, GAVETA 15 E 19"), arm(4, "Prateleira 1, Gaveta 15 e 19"));
  assert.deepEqual(interpretarLocal("ARMARIO 4 PRATELEIRA 2 CAIXA GAVETEIRO"), arm(4, "Prateleira 2, Caixa gaveteiro"));
  assert.deepEqual(interpretarLocal("ARMARIO 4 PRATELEIRA 3 CAIXA GAVETEIRO 3"), arm(4, "Prateleira 3, Caixa gaveteiro 3"));
  assert.deepEqual(interpretarLocal("ARMARIO 4, PRATELEIRA 3, GAVETEIRO 2"), arm(4, "Prateleira 3, Gaveteiro 2"));
  assert.deepEqual(interpretarLocal("Armario 4 Caixa F"), arm(4, "Caixa F"));
  assert.deepEqual(interpretarLocal("Armario 7, gaveta 1, caixa 6-7"), arm(7, "Gaveta 1, Caixa 6-7"));
  assert.deepEqual(interpretarLocal("Armario 7, gaveta 2, posição 1-9"), arm(7, "Gaveta 2, Posição 1-9"));
  assert.deepEqual(interpretarLocal("Armario 7, gaveta 2, caixa de acrílico"), arm(7, "Gaveta 2, Caixa de acrilico"));
});

test("local: só o armário, bancada e o local de exemplo do site de coleta", () => {
  assert.deepEqual(interpretarLocal("ARMARIO 6"), arm(6, ""));
  assert.deepEqual(interpretarLocal("Armário 3"), arm(3, ""));
  assert.deepEqual(interpretarLocal("Bancada eletrônica"), { grupo: "bancada", numero: null, detalhe: "" });
  assert.deepEqual(interpretarLocal("Bancada de eletrônica"), { grupo: "bancada", numero: null, detalhe: "" });
  assert.equal(interpretarLocal("Armário 01 > Prateleira A").grupo, "confirmar");
  assert.equal(interpretarLocal("").grupo, "confirmar");
  assert.equal(interpretarLocal("sala dos fundos").grupo, "confirmar");
});

test("variações do mesmo lugar viram a mesma posição", () => {
  const k = (t) => chavePosicao(interpretarLocal(t));
  assert.equal(k("ARMARIO 4 PRATELEIRA 1 GV-16"), k("armario 4, prateleira 1, gaveta 16"));
  assert.equal(k("Bancada eletrônica"), k("Bancada de eletrônica"));
  assert.notEqual(k("ARMARIO 4 PRATELEIRA 1 GV-16"), k("ARMARIO 4 PRATELEIRA 1 GV-18"));
  assert.notEqual(k("ARMARIO 4"), k("ARMARIO 6"));
  assert.equal(nomePosicao(interpretarLocal("ARMARIO 6")), "Geral");
});

test("nome da categoria", () => {
  assert.equal(nomeCategoria("QUÍMICO"), "Químico");
  assert.equal(nomeCategoria("bancada"), "Bancada");
  assert.equal(nomeCategoria("INSTRUMENTOS"), "Instrumentos");
  assert.equal(nomeCategoria("Ferramentas"), "Ferramentas");
  assert.equal(nomeCategoria("EPI"), "EPI");
  assert.equal(nomeCategoria(""), "Outros");
});

test("foto: entre várias, a mais recente; chave de entrada fixa e em formato de UUID", () => {
  assert.equal(escolherFoto(["FER-018_20261110T173000.jpg", "FER-018_20261110T191500.jpg", "FER-018_20261110T180000.jpg"]), "FER-018_20261110T191500.jpg");
  assert.equal(escolherFoto([]), null);
  assert.equal(chaveEntrada("ALI-001"), chaveEntrada("ALI-001"));
  assert.notEqual(chaveEntrada("ALI-001"), chaveEntrada("ALI-002"));
  assert.match(chaveEntrada("ALI-001"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
