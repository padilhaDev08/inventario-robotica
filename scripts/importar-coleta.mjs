// Importa para o banco as peças da coleta (planilha convertida em JSON) e as fotos.
// Veja docs/18-importar-coleta.md. Resumo:
//
//   Simulação (não grava nada):  node scripts/importar-coleta.mjs --dados dados-coleta/coleta.json --fotos "C:\...\Fotos"
//   Gravar de verdade:           o mesmo comando com --aplicar
//
// Variáveis de ambiente:
//   IMPORT_URL    endereço do Supabase (padrão: http://127.0.0.1:54321, o banco local)
//   IMPORT_CHAVE  chave pública (anon / publishable). NUNCA a service_role.
//   IMPORT_EMAIL  e-mail de um ADMINISTRADOR do sistema
//   IMPORT_SENHA  senha dele (se faltar, o programa pergunta, sem mostrar o que você digita)
//
// Entra com o login de administrador, então vale todas as regras de permissão do sistema (RLS).
// Pode ser rodado de novo sem duplicar: itens que já existem são pulados (a foto é completada se faltar,
// e o estoque só entra em item que nunca teve movimentação).

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { montarDescricao, sugerirPrefixo, tipoControleSugerido } from "../src/features/itens/importacao.ts";
import {
  chaveEntrada,
  chavePosicao,
  escolherFoto,
  interpretarLocal,
  nomeCategoria,
  nomePosicao,
  normalizarTexto,
} from "./importar-coleta-regras.mjs";

// ---------------------------------------------------------------- argumentos
const args = process.argv.slice(2);
const opcao = (nome) => {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
};
const aplicar = args.includes("--aplicar");
const arquivoDados = opcao("--dados");
const pastaFotos = opcao("--fotos");
// Corrige armários escritos errados na coleta. Ex.: --trocar-armario 7=5,3=4 (o que estava como 7 vira 5, o 3 vira 4)
const trocasArmario = new Map(
  (opcao("--trocar-armario") ?? "")
    .split(",")
    .filter(Boolean)
    .map((par) => par.split("=").map(Number)),
);
// Armários que existem de verdade. Item com armário fora desta lista fica em "A confirmar" em vez de inventar um armário.
const armariosValidos = (opcao("--armarios") ?? "")
  .split(",")
  .filter(Boolean)
  .map(Number);
if (!arquivoDados) {
  console.error("Falta --dados <arquivo.json>. Veja docs/18-importar-coleta.md.");
  process.exit(2);
}

const URL_BANCO = (process.env.IMPORT_URL ?? "http://127.0.0.1:54321").replace(/\/$/, "");
const CHAVE = process.env.IMPORT_CHAVE;
const EMAIL = process.env.IMPORT_EMAIL;
if (!CHAVE || !EMAIL) {
  console.error("Faltam IMPORT_CHAVE e IMPORT_EMAIL (veja docs/18-importar-coleta.md).");
  process.exit(2);
}

function perguntarSenha() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const saida = rl;
    saida._writeToOutput = () => {}; // não mostra o que é digitado
    process.stdout.write(`Senha de ${EMAIL}: `);
    rl.question("", (resposta) => {
      rl.close();
      process.stdout.write("\n");
      resolve(resposta);
    });
  });
}

// ---------------------------------------------------------------- dados da planilha
const dados = JSON.parse(readFileSync(arquivoDados, "utf8"));
const pecas = dados.pecas.map((p) => ({
  codigo: String(p["Código"]).trim().toUpperCase(),
  nome: String(p["Nome"]).replace(/\s+/g, " ").trim(),
  quantidade: Math.round(Number(String(p["Quantidade"]).replace(",", ".")) || 0),
  local: String(p["Local"] ?? "").trim(),
  categoriaTexto: String(p["Categoria"] ?? "").trim(),
  obs: String(p["Observações"] ?? "").replace(/\s+/g, " ").trim(),
}));
const prefixoDaAba = new Map((dados.categorias ?? []).map(([nome, prefixo]) => [normalizarTexto(nome), String(prefixo).toUpperCase()]));
const fotosPorCodigo = dados.fotos ?? {};

// ---------------------------------------------------------------- entrada no banco
const supabase = createClient(URL_BANCO, CHAVE, { auth: { persistSession: false, autoRefreshToken: false } });
const ehLocal = /127\.0\.0\.1|localhost/.test(URL_BANCO);
console.log(`\nBanco: ${URL_BANCO} (${ehLocal ? "LOCAL, de teste" : "NUVEM"})`);
console.log(aplicar ? "Modo: GRAVAR" : "Modo: SIMULAÇÃO (nada será gravado; use --aplicar para gravar)");

const senha = process.env.IMPORT_SENHA ?? (await perguntarSenha());
const { data: sessao, error: erroLogin } = await supabase.auth.signInWithPassword({ email: EMAIL, password: senha });
if (erroLogin) {
  console.error(`Não consegui entrar: ${erroLogin.message}`);
  process.exit(1);
}
const { data: perfil } = await supabase.from("perfis").select("perfil, status_cadastro, nome").eq("id", sessao.user.id).single();
console.log(`Entrou como ${perfil?.nome ?? EMAIL} (${perfil?.perfil}, cadastro ${perfil?.status_cadastro})`);
if (perfil?.perfil !== "admin" || perfil?.status_cadastro !== "aprovado") {
  console.error("Este programa precisa de um ADMINISTRADOR aprovado (ele cria tipos de endereço e categorias).");
  process.exit(1);
}

async function ler(consulta, rotulo) {
  const { data, error } = await consulta;
  if (error) throw new Error(`${rotulo}: ${error.message}`);
  return data ?? [];
}
const existentes = {
  categorias: await ler(supabase.from("categorias").select("id, nome, prefixo"), "categorias"),
  itens: await ler(supabase.from("vw_itens_estoque").select("id, codigo, nome, foto_url, saldo_total"), "itens"),
  tipos: await ler(supabase.from("tipos_endereco").select("id, nome, prefixo, nivel, armazena_itens"), "tipos de endereço"),
  enderecos: await ler(supabase.from("enderecos").select("id, codigo, nome, pai_id, tipo_endereco_id, ativo"), "endereços"),
};

// ---------------------------------------------------------------- plano
// Categorias
const usados = new Set(existentes.categorias.map((c) => c.prefixo));
const porNomeCategoria = new Map(existentes.categorias.map((c) => [normalizarTexto(c.nome), c]));
const categoriasNovas = new Map(); // chave -> { nome, prefixo, tipoControle }
const categoriaDaPeca = new Map(); // codigo -> chave
for (const p of pecas) {
  const nome = nomeCategoria(p.categoriaTexto);
  const chave = normalizarTexto(nome);
  categoriaDaPeca.set(p.codigo, chave);
  if (porNomeCategoria.has(chave) || categoriasNovas.has(chave)) continue;
  let prefixo = prefixoDaAba.get(normalizarTexto(p.categoriaTexto)) ?? sugerirPrefixo(nome, usados);
  if (usados.has(prefixo) || !/^[A-Z]{2,5}$/.test(prefixo)) prefixo = sugerirPrefixo(nome, usados);
  usados.add(prefixo);
  categoriasNovas.set(chave, { nome, prefixo, tipoControle: tipoControleSugerido(nome) });
}

// Itens
const itemPorCodigo = new Map(existentes.itens.map((i) => [String(i.codigo).toUpperCase(), i]));
const itensNovos = [];
const itensExistentes = [];
const conflitos = [];
for (const p of pecas) {
  const ex = itemPorCodigo.get(p.codigo);
  if (!ex) itensNovos.push(p);
  else if (normalizarTexto(ex.nome) === normalizarTexto(p.nome)) itensExistentes.push({ p, ex });
  else conflitos.push({ p, ex });
}

// Locais
const locaisDaPeca = new Map(); // codigo -> { loc, chave }
const posicoes = new Map(); // chave -> { loc, nome, qtdItens }
const CONFIRMAR = { grupo: "confirmar", numero: null, detalhe: "" };
const itensPorArmarioOriginal = new Map(); // só para o relatório: como veio da planilha
for (const p of [...itensNovos, ...itensExistentes.map((x) => x.p)]) {
  const loc0 = interpretarLocal(p.local);
  if (loc0.grupo === "armario") itensPorArmarioOriginal.set(loc0.numero, [...(itensPorArmarioOriginal.get(loc0.numero) ?? []), p.codigo]);
  const loc = loc0.grupo === "armario" && trocasArmario.has(loc0.numero) ? { ...loc0, numero: trocasArmario.get(loc0.numero) } : loc0;
  const foraDaLista = loc.grupo === "armario" && armariosValidos.length > 0 && !armariosValidos.includes(loc.numero);
  const efetivo = loc.grupo === "confirmar" || foraDaLista ? CONFIRMAR : loc;
  const chave = chavePosicao(efetivo);
  locaisDaPeca.set(p.codigo, { loc: efetivo, chave });
  const atual = posicoes.get(chave) ?? { loc: efetivo, nome: efetivo.grupo === "confirmar" ? "Local a confirmar" : nomePosicao(efetivo), qtdItens: 0 };
  atual.qtdItens++;
  posicoes.set(chave, atual);
}
const numerosArmario = [...new Set([...posicoes.values()].filter((x) => x.loc.grupo === "armario").map((x) => x.loc.numero))].sort((a, b) => a - b);

// Fotos
const fotoDoCodigo = new Map();
for (const p of [...itensNovos, ...itensExistentes.map((x) => x.p)]) {
  const f = escolherFoto(fotosPorCodigo[p.codigo] ?? []);
  if (f) fotoDoCodigo.set(p.codigo, f);
}

// ---------------------------------------------------------------- relatório do plano
console.log("\n=== PLANO ===");
console.log(`Peças na planilha: ${pecas.length}`);
console.log(`  novas (serão criadas): ${itensNovos.length}`);
console.log(`  já existem com o mesmo nome (puladas; foto completada se faltar): ${itensExistentes.length}`);
console.log(`  CONFLITO (mesmo código, outro nome; NÃO serão importadas): ${conflitos.length}`);
for (const c of conflitos) console.log(`    ${c.p.codigo}: planilha "${c.p.nome}" x banco "${c.ex.nome}"`);
console.log(`Categorias novas: ${categoriasNovas.size}`);
for (const c of categoriasNovas.values()) console.log(`    ${c.nome} (${c.prefixo}) - ${c.tipoControle}`);
console.log(`Categorias que já existem e serão usadas: ${[...new Set(pecas.map((p) => categoriaDaPeca.get(p.codigo)))].filter((c) => porNomeCategoria.has(c)).length}`);
console.log("Itens por armário, como veio da planilha:");
for (const [n, codigos] of [...itensPorArmarioOriginal].sort((a, b) => a[0] - b[0])) {
  const destino = trocasArmario.has(n) ? ` -> vira Armário ${trocasArmario.get(n)}` : armariosValidos.length && !armariosValidos.includes(n) ? " -> A CONFIRMAR (armário fora da lista)" : "";
  console.log(`    Armário ${n}: ${codigos.length} item(ns)${destino}${n !== 4 && n !== 6 ? "  [" + codigos.join(", ") + "]" : ""}`);
}
console.log(`Armários usados: ${numerosArmario.join(", ") || "nenhum"} | Posições: ${posicoes.size} | com bancada: ${[...posicoes.values()].some((x) => x.loc.grupo === "bancada")} | a confirmar: ${posicoes.has(chavePosicao(CONFIRMAR)) ? posicoes.get(chavePosicao(CONFIRMAR)).qtdItens + " item(ns)" : "nenhum"}`);
console.log(`Fotos a enviar: ${fotoDoCodigo.size} | peças sem foto: ${pecas.length - conflitos.length - fotoDoCodigo.size}`);
console.log(`Estoque total a lançar: ${[...itensNovos].reduce((s, p) => s + p.quantidade, 0)} unidades em ${itensNovos.filter((p) => p.quantidade > 0).length} itens`);

if (!aplicar) {
  console.log("\nSimulação terminada. Nada foi gravado. Para gravar, rode de novo com --aplicar.");
  process.exit(conflitos.length ? 3 : 0);
}

// ---------------------------------------------------------------- gravação
const falhas = [];
const falhar = (onde, erro) => {
  falhas.push(`${onde}: ${erro?.message ?? erro}`);
  console.log(`  FALHOU ${onde}: ${erro?.message ?? erro}`);
};

async function garantirTipo(nome, prefixo, nivel, armazenaItens) {
  const achado = existentes.tipos.find((t) => t.prefixo === prefixo);
  if (achado) return achado;
  const { data, error } = await supabase.from("tipos_endereco").insert({ nome, prefixo, nivel, armazena_itens: armazenaItens }).select("id, nome, prefixo, nivel, armazena_itens").single();
  if (error) throw new Error(`tipo de endereço ${nome}: ${error.message}`);
  existentes.tipos.push(data);
  console.log(`  tipo de endereço criado: ${nome} (${prefixo})`);
  return data;
}

async function garantirEndereco(tipo, paiId, nome) {
  const achado = existentes.enderecos.find((e) => e.tipo_endereco_id === tipo.id && e.pai_id === paiId && normalizarTexto(e.nome ?? "") === normalizarTexto(nome));
  if (achado) return achado;
  const { data, error } = await supabase.from("enderecos").insert({ tipo_endereco_id: tipo.id, pai_id: paiId, nome }).select("id, codigo, nome, pai_id, tipo_endereco_id, ativo").single();
  if (error) throw new Error(`endereço ${nome}: ${error.message}`);
  existentes.enderecos.push(data);
  return data;
}

console.log("\n=== GRAVANDO ===");
const idCategoria = new Map(existentes.categorias.map((c) => [normalizarTexto(c.nome), c.id]));
for (const [chave, c] of categoriasNovas) {
  const { data, error } = await supabase.from("categorias").insert({ nome: c.nome, prefixo: c.prefixo }).select("id").single();
  if (error) {
    falhar(`categoria ${c.nome}`, error);
    continue;
  }
  idCategoria.set(chave, data.id);
  console.log(`  categoria criada: ${c.nome} (${c.prefixo})`);
}
if (falhas.length) {
  console.error("\nParei: não consegui criar todas as categorias, então nenhum item foi importado.");
  process.exit(1);
}

const tipoArmario = await garantirTipo("Armário", "ARM", 1, false);
const tipoPosicao = await garantirTipo("Posição", "P", 4, true);
const tipoBancada = [...posicoes.values()].some((x) => x.loc.grupo === "bancada") ? await garantirTipo("Bancada", "BAN", 1, false) : null;
const tipoProvisorio = posicoes.has(chavePosicao(CONFIRMAR)) ? await garantirTipo("Provisório", "PRV", 1, false) : null;

// Armários em ordem (o número do código acompanha o do armário quando o banco ainda não tem nenhum)
const armarios = new Map(); // numero -> endereco
const semArmarios = existentes.enderecos.every((e) => e.tipo_endereco_id !== tipoArmario.id);
const ate = numerosArmario.at(-1) ?? 0;
for (let n = 1; n <= ate; n++) {
  const necessario = numerosArmario.includes(n);
  if (!necessario && !semArmarios) continue;
  try {
    const arm = await garantirEndereco(tipoArmario, null, `Armário ${n}`);
    armarios.set(n, arm);
    // Número de preenchimento (o armário não existe de verdade): criado só para o código acompanhar o número, e desativado
    if (!necessario && arm.ativo) {
      const { error } = await supabase.from("enderecos").update({ ativo: false }).eq("id", arm.id);
      if (error) throw new Error(`desativar Armário ${n}: ${error.message}`);
      console.log(`  Armário ${n} criado só para alinhar o código (${arm.codigo}) e desativado`);
    }
  } catch (e) {
    falhar(`Armário ${n}`, e);
  }
}
const paiBancada = tipoBancada ? await garantirEndereco(tipoBancada, null, "Bancada de eletrônica") : null;
const paiProvisorio = tipoProvisorio ? await garantirEndereco(tipoProvisorio, null, "A confirmar") : null;

const enderecoDaPosicao = new Map(); // chave -> endereco
for (const [chave, pos] of posicoes) {
  const pai = pos.loc.grupo === "armario" ? armarios.get(pos.loc.numero) : pos.loc.grupo === "bancada" ? paiBancada : paiProvisorio;
  if (!pai) {
    falhar(`posição ${pos.nome}`, "endereço-pai não existe");
    continue;
  }
  try {
    enderecoDaPosicao.set(chave, await garantirEndereco(tipoPosicao, pai.id, pos.nome));
  } catch (e) {
    falhar(`posição ${pos.nome}`, e);
  }
}
console.log(`  endereços prontos: ${armarios.size} armário(s), ${enderecoDaPosicao.size} posição(ões)`);

async function enviarFoto(itemId, codigo) {
  const arquivo = fotoDoCodigo.get(codigo);
  if (!arquivo || !pastaFotos) return "sem foto";
  const bytes = readFileSync(join(pastaFotos, arquivo));
  const caminho = `${itemId}/${Date.now()}.jpg`;
  const { error } = await supabase.storage.from("itens-fotos").upload(caminho, bytes, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error(`envio da foto: ${error.message}`);
  const { error: erroFoto } = await supabase.from("itens").update({ foto_url: caminho }).eq("id", itemId);
  if (erroFoto) throw new Error(`gravar foto_url: ${erroFoto.message}`);
  return "foto enviada";
}

async function lancarEstoque(itemId, p) {
  const alvo = enderecoDaPosicao.get(locaisDaPeca.get(p.codigo)?.chave);
  if (!alvo) throw new Error("sem posição para lançar o estoque");
  if (p.quantidade <= 0) return "quantidade 0: sem entrada";
  const { error } = await supabase.rpc("registrar_entrada", {
    p_item_id: itemId,
    p_endereco_id: alvo.id,
    p_quantidade: p.quantidade,
    p_chave_idempotencia: chaveEntrada(p.codigo),
    p_motivo: "Importação da coleta",
  });
  if (error) throw new Error(`entrada de estoque: ${error.message}`);
  return `entrada de ${p.quantidade} em ${alvo.codigo}`;
}

let criados = 0;
let comFoto = 0;
let comEstoque = 0;
for (const [n, p] of itensNovos.entries()) {
  const chaveCat = categoriaDaPeca.get(p.codigo);
  const categoriaId = idCategoria.get(chaveCat);
  const tipoControle = categoriasNovas.get(chaveCat)?.tipoControle ?? tipoControleSugerido(nomeCategoria(p.categoriaTexto));
  const rotulo = `[${n + 1}/${itensNovos.length}] ${p.codigo}`;
  if (!categoriaId) {
    falhar(rotulo, "categoria sem id");
    continue;
  }
  const { data, error } = await supabase
    .from("itens")
    .insert({ codigo: p.codigo, nome: p.nome, categoria_id: categoriaId, unidade: "un", tipo_controle: tipoControle, descricao: montarDescricao(p.obs, p.local) })
    .select("id, codigo")
    .single();
  if (error) {
    falhar(rotulo, error);
    continue;
  }
  criados++;
  const partes = [];
  try {
    const r = await enviarFoto(data.id, p.codigo);
    if (r === "foto enviada") comFoto++;
    partes.push(r);
  } catch (e) {
    falhar(`${rotulo} foto`, e);
  }
  try {
    const r = await lancarEstoque(data.id, p);
    if (r.startsWith("entrada")) comEstoque++;
    partes.push(r);
  } catch (e) {
    falhar(`${rotulo} estoque`, e);
  }
  console.log(`  ${rotulo} ${p.nome.slice(0, 40)}: ${partes.join(" | ")}`);
}

// Itens que já existiam: completa só o que falta
for (const { p, ex } of itensExistentes) {
  const partes = [];
  try {
    if (!ex.foto_url && fotoDoCodigo.has(p.codigo)) partes.push(await enviarFoto(ex.id, p.codigo));
    const { data: movs } = await supabase.from("movimentacoes").select("id").eq("item_id", ex.id).limit(1);
    if (!movs?.length) partes.push(await lancarEstoque(ex.id, p));
  } catch (e) {
    falhar(`${p.codigo} (já existia)`, e);
  }
  if (partes.length) console.log(`  ${p.codigo} (já existia): ${partes.join(" | ")}`);
}

console.log("\n=== RESULTADO ===");
console.log(`Itens criados: ${criados} de ${itensNovos.length} | com foto: ${comFoto} | com estoque lançado: ${comEstoque}`);
console.log(`Conflitos (não importados): ${conflitos.length}`);
console.log(`Falhas: ${falhas.length}`);
for (const f of falhas) console.log(`  - ${f}`);
console.log("\nPosições criadas (para imprimir as etiquetas depois):");
for (const [chave, e] of enderecoDaPosicao) console.log(`  ${e.codigo}  ${posicoes.get(chave).nome}  (${posicoes.get(chave).qtdItens} item(ns))`);
process.exit(falhas.length || conflitos.length ? 1 : 0);
