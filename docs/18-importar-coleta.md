# Importar as peças e fotos da coleta para o banco

Leva para o banco as peças que foram contadas no site de coleta (planilha do Google) e as fotos tiradas lá: **código, nome, categoria, observações, quantidade em estoque, foto e local**.

Diferente de **Itens > Importar planilha** (que está na tela e só cuida dos dados), este programa também envia as **fotos** e cria os **endereços** (armários e posições). Serve para a carga inicial; depois, o dia a dia é feito pelo sistema.

## O que ele faz

1. Entra com um login de **administrador** (vale todas as regras de permissão; não usa chave especial).
2. Cria as **categorias** que faltam. O prefixo vem da aba `Categorias` da planilha. Ferramentas, Equipamento, Instrumentos, KIT, Caixa e EPI ficam como **emprestáveis**; as demais, como consumíveis.
3. Cria os **endereços**: um `Armário N` para cada armário, e dentro dele uma **posição** para cada local distinto da planilha, com o nome limpo (ex.: `ARMARIO 4 PRATELEIRA 1 GV-16` vira a posição **Prateleira 1, Gaveta 16**). Erros de digitação ("ARMRAIO", "PRALEIRA", "GV- 10") são corrigidos.
4. Cadastra cada peça **com o mesmo código da coleta** (`ALI-001`, `CHAV-001`...), o texto do local original na descrição, e lança a **quantidade como entrada de estoque** na posição.
5. Envia a **foto** de cada peça. Se houver várias fotos do mesmo código, usa a **mais recente**.

Peças sem foto ficam sem foto. Códigos que **já existem no banco com outro nome** são **recusados** (conflito) e listados, para você decidir.

## Armários que não existem

O programa **não inventa armário**. Use `--armarios 4,5,6` (os que existem de verdade). Peças cujo local aponta para outro armário vão para o endereço **A confirmar** (`PRV01`), e você move depois com **Movimentações > Transferir**. Se na planilha um armário está escrito errado (ex.: o 7 é na verdade o 5), corrija com `--trocar-armario 7=5`.

## Como rodar

Preparação (uma vez, na pasta do projeto): a planilha convertida em `dados-coleta/coleta.json` e a pasta das fotos. Essa pasta `dados-coleta/` **não vai para o GitHub** (está no `.gitignore`).

```
$env:IMPORT_URL="https://SEU-REF.supabase.co"        # o banco local é http://127.0.0.1:54321
$env:IMPORT_CHAVE="a chave anon / publishable"       # nunca a service_role
$env:IMPORT_EMAIL="e-mail de um administrador"
node scripts/importar-coleta.mjs --dados dados-coleta/coleta.json --fotos "C:\...\Fotos - Inventário Robótica" --armarios 4,5,6
```

Esse primeiro comando é **simulação**: mostra o plano (categorias, armários, posições, conflitos, fotos) e **não grava nada**. Ele pergunta a senha do administrador sem mostrar o que você digita.

Quando o plano estiver certo, rode de novo com `--aplicar` no final.

Pode repetir sem duplicar: peças que já existem são puladas (a foto é completada se faltar, e o estoque só entra em peça que nunca teve movimentação).

## No banco da nuvem (Supabase)

1. Aplique as tabelas: `npx.cmd supabase db push` (veja `docs/17-netlify.md`).
2. Crie o administrador: no painel do Supabase, **Authentication > Users > Add user** (marque *Auto Confirm User*), depois no **SQL Editor**:
   ```sql
   update public.perfis set perfil = 'admin', status_cadastro = 'aprovado' where email = 'seu@email.com';
   ```
3. Rode o programa como acima, com a URL e a chave do projeto na nuvem. Com o banco da nuvem vazio, os códigos dos armários acompanham o número (`ARM04` = Armário 4; os números que não existem são criados e desativados só para alinhar).

## Depois de importar

- Imprima as etiquetas: **Endereços > Etiquetas de tudo dentro** (posições) e **Itens > Etiquetas** (peças).
- Confira o endereço **A confirmar** e mova o que estiver nele para o lugar certo.
- No banco local de teste, 5 códigos do `seed.sql` (`FER-001`, `FER-002`, `FER-003`, `FER-005`, `SEN-001`) dão conflito, porque os itens de exemplo usam os mesmos códigos. Na nuvem não existe seed, então não há conflito.

Testes das regras de limpeza de locais: `tests/importar-coleta.test.mjs` (rodam no `npm test`).
