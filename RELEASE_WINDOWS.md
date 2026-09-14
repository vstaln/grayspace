# Windows-релиз OrcSpace

Этот файл описывает единственный правильный порядок выпуска Windows-версии и загрузки установщика в `orcspace/Orcspace-Uptade`.

## 1. Подготовить версию

Работать из корня репозитория на Windows.

```powershell
$Version = "2.0.4" # заменить на нужную новую версию
npm version $Version --no-git-tag-version
git status --short
```

Версия в `package.json` и `package-lock.json` должна совпадать. Не переиспользовать уже опубликованный тег `v$Version`.

## 2. Собрать установщик

Для релизной сборки использовать полный скрипт:

```powershell
node scripts/build-installer.mjs
```

Скрипт сам выполняет `npm ci`, typecheck, тесты, security-проверку, сборку, smoke-проверку и упаковку NSIS.

После успешной сборки в `dist` должны быть только необходимые для автообновления артефакты:

```text
OrcSpace-Setup-$Version-x64.exe
OrcSpace-Setup-$Version-x64.exe.blockmap
latest.yml
```

`latest.yml` и `.blockmap` нельзя редактировать вручную: они должны быть сгенерированы для того же `.exe`.

Проверить манифест:

```powershell
Get-Content dist/latest.yml
Get-Content dist/checksums.json
```

В `latest.yml` должны быть `version: $Version`, имя текущего `.exe`, его размер и `sha512`.

## 3. Зафиксировать код и создать тег

Перед публикацией убедиться, что в коммит не попали скриншоты, временные файлы и содержимое `dist`.

```powershell
git diff --check
git add -u
git commit -m "release: prepare OrcSpace $Version"
git tag -a "v$Version" -m "Release v$Version"
git push origin main
git push origin "v$Version"
```

Публикация тега запускает `.github/workflows/release.yml`. Если workflow уже создал релиз в `Orcspace-Uptade`, повторно его не создавать — нужно только проверить ассеты.

## 4. Загрузить через GitHub браузер

Открыть:

```text
https://github.com/orcspace/Orcspace-Uptade/releases/new?tag=v$Version
```

В форме релиза:

1. Выбрать или создать тег `v$Version`.
2. Заголовок: `OrcSpace v$Version`.
3. Оставить `Latest` включённым; `Pre-release` не включать.
4. Прикрепить только эти три файла из `dist`:
   - `OrcSpace-Setup-$Version-x64.exe`
   - `OrcSpace-Setup-$Version-x64.exe.blockmap`
   - `latest.yml`
5. Дождаться окончания загрузки и нажать `Publish release`.

GitHub автоматически показывает `Source code (zip)` и `Source code (tar.gz)` — это нормально; вручную загружаются только три файла выше.

## 5. Финальная проверка

На странице опубликованного релиза проверить:

- релиз имеет номер `v$Version` и помечен `Latest`;
- присутствуют `.exe`, `.blockmap` и `latest.yml`;
- в `latest.yml` имя `.exe` совпадает с опубликованным файлом;
- версия в `latest.yml` совпадает с версией приложения;
- `.exe` скачивается без ошибки.

Только после этих проверок релиз считается готовым для `electron-updater`.
