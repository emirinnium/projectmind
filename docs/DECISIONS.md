# Agent / Model Decision Log

Kalıcı mimari kararların kaydı. Bu dosya, önceki oturumlarda ProjectMind hafızasına (`store_memory`, scope: "decisions") kaydedilen kararların da alıntılanabilir bir yedeğini tutar.

## Karar Formatı

`decision:{alan}:{konu}` anahtarı — ProjectMind `store_memory { scope: "decisions", key: <bu anahtar>, value: <ne + neden> }` ile eşleşir.

---

## 🧩 Automation Agent — 6 Model Pipeline Rol Dağılımı

**Anahtar:** `decision:automation:pipeline-model-roles`
**Tarih:** güncel

Orkestrasyon pipeline'ı (discover → analyze → plan → code → verify → re-analyze → discover, sürekli mod) için nihai model rol haritası — nemotron ailesi direkt native `nvidia/...` provider ile (Mistral kullanım düzeniyle aynı); sadece feature-hunter tokenrouter/glm üzerinden:

| Rol | Agent | Model (provider/model-id) |
|------|-------|---------------------------|
| Orkestratör | `automation` | `kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| Analiz | `project-analyzer` | `kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| Plan | `code-planner` | `mistral/mistral-medium-2508` (native Mistral — kullanıcı tercihi, değişmedi) |
| Kod | `coder` | `kilo/nvidia/nemotron-3.5-lightning:free` |
| Verify / Reviewer | `verifier` | `kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| Özellik keşfi | `feature-hunter` | `tokenrouter/z-ai/glm-5.3-free` |

**Neden:**
- Kullanıcı ataması: orkestratör + analizci + verifier `nemotron-3-nano-omni-30b-a3b-reasoning:free`, kodcu `nemotron-3.5-lightning:free` (hızlı agentik kodlama — kullanıcı son değişiklik), sadece feature-hunter `z-ai/glm-5.3-free` (tokenrouter; 1M bağlam + keşif). Plancı bilinçli olarak `mistral-medium-2508`'de kaldı (farklı model = ikinci görüş/çeşitlilik). Sorun geçmişi & çözüm: `nvidia/nemotron-...:free` → "Model not found"; `nvidia/nemotron-...-reasoning` (soneksiz) → yine "Model not found". `:free` sonekli id'ler **yalnızca** `kilo` provider kataloğunda mevcut (models.dev `kilo` = kilo.ai/api/gateway, env `KILO_API_KEY`). Bu nedenle nemotron modelleri `kilo/nvidia/...:free` referansı ile kullanılır. `opencode.json` → `provider.kilo.options.apiKey: "{env:KILO_API_KEY}"`. Not: `.env`'de KILO_API_KEY henüz YOK — set edilmeden runtime 401/alım hatası verir. Not: `decision:automation:pipeline-model-roles` bellek kaydı da yeni harita ile güncellenmelidir (store_memory).

**Kapsam / config konumu:**
- `opencode.json` → `agent.*.model`
- `.opencode/agents/*.md` → frontmatter `model:` (md frontmatter config'i ezer; ikisini de güncelle)

---

## 📬 Plan Handoff — Plancı → Coder (byte-birebir, memory üzerinden)

**Anahtar:** `decision:agents:plan-handoff`
**Tarih:** güncel

**Sorun (kanıtlı):** `scan_cves` feature'ı için plancı (`mistral-medium-2508`) tam bir plan üretti, ancak koduya giden prompt **farklı bir plan** içeriyordu — orkestratör (`nano-omni`) planı verbatim kopyalamak yerine kendi hafızasından (önceki item'ler `recommend_skills`/`find_symbol_references`) yeniden yazdı. Oturum DB'sinden doğrulandı: iki coder denemesinde de prompt `scan_cves` planından hiçbir şey içermiyordu ve `scan-cves.ts` hiç yazılmadı; onun yerine `skill-recommend.ts` içerikleri geliştirildi.

**Çözüm:** Plan LLM'ler arası serbest metin değil, ProjectMind **memory**'de taşınır (byte-birebir):
- `code-planner`: planın tamamını `<PLAN_BEGIN>...</PLAN_END>` içinde döndürür VE `projectmind_store_memory(scope="plans", key="active-plan", value=<PLAN_BEGIN>...</PLAN_END>)` ile kalıcı yazar. (`code-planner` için `projectmind_*: allow` eklendi.)
- `automation`: planı **asla yeniden yazmaz**. Sadece `projectmind_get_memory(plans/active-plan)` ile varlığını doğrular (GATE 2). Coder prompt'u **MINIMAL**: goal kimliği + "planı memory'den çek, aynen uygula" + repo kuralları. Geçmiş item text'lerini mevcut prompt'a kopyalama/summarize etme (anti-drift).
- `coder`: **İLK adım** `projectmind_get_memory(plans/active-plan)`; depolanan plan tek otoriter kaynak. Boşsa prompt'taki `<PLAN_BEGIN>...</PLAN_END>` yedeği; o da yoksa "no plan received" raporu — asla farklı bir feature improvize etme.

**Kapsam / config konumu:**
- `.opencode/agents/code-planner.md` → PLAN_BEGIN/END sarmalama + PERSIST adımı + `projectmind_*: allow`
- `.opencode/agents/automation.md` → PLAN HANDOFF PROTOCOL bölümü + Step 3/7 minimal prompt + GATE 2 memory kontrolü + CONTEXT PASSING güncellemesi
- `.opencode/agents/coder.md` → MANDATORY WORKFLOW madde 1 (planı memory'den çek)

---

## 🔁 Automation Pipeline — Koşullu Döngü Mantığı (analiz → plan → kod → analiz...)

**Anahtar:** `decision:automation:pipeline-loop-bounded`
**Tarih:** güncel

Orkestrasyon, **sınırlı ve hedefle sonlanan** bir döngü çalıştırır:
`analiz → plan → kod → analiz → plan → kod → ...`

- **Plancı** plan yapar + **check edilebilir TODO list** çıkarır.
- **Coder** her TODO'yu `[x]` ile işaretler (tamamlar).
- **Döngü analize döner.** Analizci yeniden kontrol eder:
  - **Problem yok + hedeflenen özellikler tamamlandıysa → döngü sonuçlanır.**
  - **Olmadıysa → devam eder** → plan → kod → analiz → plan → kod ...

**Neden / önemli not:**
- Bu, "loop forever / you never loop indefinitely" DEĞİL — her iterasyon tamamlanmaya yaklaşır, kalan sorun kalmayınca durur.
- Orkestratör tarafı (`automation.md`) GATE 0-4 ile zaten bu döngüyü yürütüyor (GATE 4: yeşil + iki ardışık temiz analiz → dur, aksi halde Faz 1→2→3'e dön).
- Eksik olan **plancının bu döngünün farkında olmamasıydı**; `code-planner.md`'ye eklendi:
  - `🔁 PIPELINE LOOP CONTEXT` bölümü (plancı = döngünün "plan" düğümü)
  - Plan yapısına `✅ TODO LIST`, `🏁 COMPLETION CRITERIA`, `🔄 CONTINUE TRIGGERS` blokları
  - Sonraki iterasyonda yalnızca hâlâ açık görevleri planla (bitmişi `[x]` işaretle, yeniden planlama)

**Kapsam / config konumu:**
- `.opencode/agents/code-planner.md` → LOOP CONTEXT + TODO/COMPLETION/CONTINUE blokları
- `.opencode/agents/automation.md` → GATE 0-4 döngü yürütme (değişmedi, zaten tutarlı)

---

## 🧱 Sub-Agent Ayrıştırması — Verifier + 2 Fazlı Plancı (Performans)

**Anahtar:** `decision:automation:subagent-split-verifier-2phase`
**Tarih:** güncel

**Motivasyon:** Sub-agent'lar arka arkaya (sequential) çalıştığı için her birinin `npm run typecheck/lint/test` çalıştırması aşırı uzun sürüyordu — aynı ağır build komutları her agent'ta tekrar tekrar koşuyordu. Çözüm: build/test komutlarını **tek** sub-agent'a konsolide etmek ve plancıyı **2 fazlı** yapmak.

**Yeni mimari (4 sub-agent):**
| Rol | Sub-agent | Ne yapar | bash/build |
|------|-----------|----------|-----------|
| Orkestratör | `automation` | döngüyü yürütür, `task` ile delege eder | read-only ONLY (**build yok**) |
| Derin tarama | `project-analyzer` | **read-only** bütün dosyaları tek tek tarar; hata/eksik/tamamlanmamış/işlevsiz/pseudo/boş kod bulur | read-only (**build yok**, statik) |
| Planlama | `code-planner` | **2 fazlı**: Faz 1 (FIX = analiz hatalarını gider) / Faz 2 (FEATURE = user-input özellikleri) | read-only (**build yok**) |
| Kod | `coder` | planı uygular, `edit/write` | read-only (**build yok**) |
| **Doğrulama** | `verifier` (YENİ) | `npm run typecheck / lint / test / build` koşar, PASS/FAIL dosya:satır raporlar | **build komutları SADECE burada** |

**2 Katmanlı döngü (bounded, goal-terminating):**
- **Katman 1 (FIX):** analiz → plancı(Faz-1) → kod → verifier → yeniden analiz → ... problemler çözülene dek.
- **Katman 2 (FEATURE):** analiz temizse → plancı(Faz-2, user-input özellikleri) → kod → verifier → yeniden analiz (hata/eksik var mı + tüm özellikler işlevsel mi) → ... tamamlanana dek.
- Her katmanda problem kalmayınca **durur** (loop forever değil).

**Neden / performans kazanımı:** `npm run typecheck/lint/test` artık sadece verifier tarafından, gerektiğinde çalıştırılır — analizci, plancı, kodcu, orkestratör bu ağır komutları çalıştırmaz. Bu, sequential pipeline'da tekrarlı build maliyetini ortadan kaldırır.

**Kapsam / config konumu:**
- `.opencode/agents/verifier.md` → YENİ verifier sub-agent (build runner)
- `.opencode/agents/code-planner.md` → 2 faz (FIX/FEATURE) + verifier-a-bırakma notu
- `.opencode/agents/project-analyzer.md` → tam dosya taraması, statik-only (build yok)
- `.opencode/agents/coder.md` → build/devretme notu (kod yaz, verifier doğrulasın)
- `.opencode/agents/automation.md` → 2 katmanlı loop + verifier delegasyonu + kendi bash'ından build'leri kaldırma
- `opencode.json` → `agent.verifier` kaydı + automation task permission'a `verifier: allow`

---

## 🧩 Automation Agent — Kaydedilmiş Önceki Kararlar (Yedek)

Aşağıdaki kararlar ProjectMind hafızasında da `decision:automation-*` anahtarlarıyla mevcut:

- `decision:automation-agent-plan-role-mistral-medium`
- `decision:automation-agent-plan-native-mistral-small`
- `decision:automation-orchestrator-mimo-pro`
- `decision:automation-inkling-models`
- `decision:automation-unbreakable-gates`
- `decision:automation-orchestrator-boundaries`
- `decision:automation-bash-allowlist-enforced`
- `decision:automation-orchestrator-glm`

Detaylar ProjectMind memory (scope decisions) üzerinden sorgulanabilir.
