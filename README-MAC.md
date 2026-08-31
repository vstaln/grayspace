# OrcSpace для macOS — Быстрая и стабильная установка (1 файл)

Руководство по установке и сборке OrcSpace на macOS (Apple Silicon M1/M2/M3/M4 и Intel x64).

---

## ⚡ Способ 1: Готовый 1-файл установщик (`.dmg`)

Самый простой и быстрый способ (стандартный для macOS):

1. **Скачайте `.dmg` файл** (например, `OrcSpace-2.0.0-arm64.dmg` для процессоров M1/M2/M3/M4 или `OrcSpace-2.0.0-x64.dmg` для Intel) со страницы **GitHub Releases** / **Actions**.
2. Откройте скачанный `.dmg` и перетащите иконку **OrcSpace** в папку **Программы (Applications)**.
3. **Первый запуск (Снятие блокировки Gatekeeper):**
   Поскольку приложение собирается без платного сертификата Apple ($99/год), macOS может написать *"Приложение повреждено"* или *"Не удается проверить разработчика"*.

   👉 Чтобы запустить без ошибок, откройте **Терминал** и выполните 1 команду:
   ```bash
   xattr -cr /Applications/OrcSpace.app
   ```
   *(Или зажмите `Control` (или `Правый клик`), нажмите на иконку OrcSpace в Программах и выберите **«Открыть»**).*

---

## 🚀 Способ 2: Автоматический установщик в 1 клик (`OrcSpace-Installer.command`)

Если у вас есть файл **`OrcSpace-Installer.command`** (или `OrcSpace-Update.command`):

1. Скачайте **`OrcSpace-Installer.command`**.
2. Дважды кликните по нему в Finder.
3. Установщик автоматически:
   - Проверит наличие Node.js и утилит Xcode.
   - Распакует OrcSpace в `~/Desktop/OrcSpace`.
   - Автоматически снимет все карантинные атрибуты macOS (`xattr -cr`).
   - Установит зависимости и запустит OrcSpace!

> Если Finder блокирует запуск скрипта: откройте Терминал и выполните:
> ```bash
> chmod +x OrcSpace-Installer.command
> ./OrcSpace-Installer.command
> ```

---

## 🛠️ Сборка `.dmg` из исходного кода на Mac

Если вы скачали архив с исходным кодом (`OrcSpace-mac-source.zip`):

1. Распакуйте архив и откройте папку в Finder.
2. Дважды кликните на **`build-mac.command`** (или выполните `./build-mac.command` в Терминале).
3. Скрипт соберет готовый `.dmg` файл в папку **`dist/`**.

### Команды сборки:
```bash
./build-mac.command          # Собирает .dmg под архитектуру текущего Mac (M-серия или Intel)
./build-mac.command --dmg    # Создает образ .dmg
./build-mac.command --all    # Собирает версии для Apple Silicon (arm64) и Intel (x64)
```

---

## 📋 Системные требования

| Требование | Как установить |
|---|---|
| macOS | Monterey, Ventura, Sonoma, Sequoia или новее |
| Node.js 20+ | `brew install node` или скачать с [nodejs.org](https://nodejs.org) |
| Xcode CLI Tools | `xcode-select --install` |
| Rust *(опционально)* | `brew install rust` *(при отсутствии используются быстрые TS-модули)* |

---

## ❓ Часто задаваемые вопросы (Решение проблем)

- **Пишет «Приложение OrcSpace повреждено и не может быть открыто»:**
  Это стандартная защита macOS Gatekeeper для неподписанных приложений.
  Решение: выполнить в Терминале:
  ```bash
  xattr -cr /Applications/OrcSpace.app
  ```

- **Терминалы внутри приложения не открываются:**
  Убедитесь, что установлены инструменты сборщика (`xcode-select --install`), удалите `node_modules` и перезапустите установщик.

- **На Mac с M1/M2/M3/M4 ошибка архитектуры:**
  Убедитесь, что Node.js установлен для `arm64`, а не запускается под Rosetta:
  `arch -arm64 brew install node`

---

# OrcSpace — macOS Guide (English)

### 1. Ready-to-use 1-File `.dmg` Installer
1. Download the `.dmg` from GitHub Releases / Actions.
2. Open the `.dmg` and drag **OrcSpace.app** to **Applications**.
3. Clear Gatekeeper quarantine:
   ```bash
   xattr -cr /Applications/OrcSpace.app
   ```
4. Launch OrcSpace!

### 2. Standalone 1-Click Installer Script
- Double-click **`OrcSpace-Installer.command`**. It unpacks, clears quarantine, installs dependencies, and launches OrcSpace seamlessly.

