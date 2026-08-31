# 🌌 OrcSpace — GitHub & Установка (Памятка)

Полная инструкция по вашему репозиторию, скачиванию готовых установщиков и управлению проектом.

---

## 🔗 Основные ссылки репозитория

* 📂 **Репозиторий GitHub:** [https://github.com/orcspace/Orcspace](https://github.com/orcspace/Orcspace)
* 💿 **Страница скачивания готовых установщиков (Releases):** [https://github.com/orcspace/Orcspace/releases](https://github.com/orcspace/Orcspace/releases)
* ⚙️ **Облачные сборки (GitHub Actions):** [https://github.com/orcspace/Orcspace/actions](https://github.com/orcspace/Orcspace/actions)
* 🔑 **SSH Remote:** `git@github.com:orcspace/Orcspace.git`

---

## 🍎 Как установить на macOS (1 файл)

### Способ 1: Готовый `.dmg` файл (Рекомендуется)
1. Перейдите в **[GitHub Releases](https://github.com/orcspace/Orcspace/releases)**.
2. Скачайте файл:
   * **`OrcSpace-2.0.0-arm64.dmg`** — для компьютеров Mac на процессорах Apple Silicon (M1, M2, M3, M4).
   * **`OrcSpace-2.0.0-x64.dmg`** — для Mac на процессорах Intel.
3. Откройте `.dmg` и перетащите иконку **OrcSpace** в папку **«Программы» (Applications)**.
4. **Снятие защиты macOS Gatekeeper (при первом запуске):**
   Если macOS пишет *«Приложение повреждено»* (так как оно без платного сертификата Apple), откройте Терминал и вставьте **1 команду**:
   ```bash
   xattr -cr /Applications/OrcSpace.app
   ```
   *После этого приложение будет открываться штатно без единой ошибки.*

### Способ 2: Автономный файл `OrcSpace-Installer.command`
1. Скопируйте файл `OrcSpace-Installer.command` на Mac.
2. Дважды кликните по нему — он сам всё распакует, настроит и запустит.

---

## 🪟 Как установить на Windows

1. Перейдите в **[GitHub Releases](https://github.com/orcspace/Orcspace/releases)** (или в локальную папку `dist/`).
2. Скачайте/запустите **`OrcSpace-Setup-2.0.0-x64.exe`** (установщик) или **`OrcSpace-2.0.0-x64-Portable.exe`** (портативная версия).
3. При появлении синего окна SmartScreen нажмите: **«Подробнее» (More info) → «Выполнить в любом случае» (Run anyway)**.

---

## 🛠️ Полезные Git-команды

### 1. Отправить новые изменения на GitHub:
```bash
git add -A
git commit -m "описание того что изменили"
git push origin main
```

### 2. Собрать новый официальный релиз (создать новый .dmg и .exe):
```bash
# Создать новый тег версии (например v2.0.1) и отправить на GitHub:
git tag v2.0.1
git push origin v2.0.1
```
*GitHub Actions автоматически подхватит тег, скомпилирует `.dmg` и выложит его во вкладку Releases.*

---

## 💻 Локальная разработка и команды проекта

| Команда | Описание |
|---|---|
| `npm run dev` | Запуск приложения в режиме разработки |
| `npm test` | Запуск всех unit-тестов (294 теста) |
| `npm run typecheck` | Проверка TypeScript без ошибок |
| `npm run dist` | Сборка установщика `.exe` для Windows |
| `npm run dist:mac:dmg` | Сборка образа `.dmg` для Mac |
| `npm run pack:archive` | Создание автономного файла `OrcSpace-Installer.command` |

---

## 🔑 SSH-ключ проекта
* **Тип:** ED25519
* **Email:** `nuramir99pro@gmail.com`
* **Файлы на ПК:** `C:\Users\user\.ssh\id_ed25519` (приватный) и `id_ed25519.pub` (публичный)
