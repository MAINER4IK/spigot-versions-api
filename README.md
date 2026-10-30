# Spigot Releases

Автоматическая сборка всех версий Spigot через GitHub Actions.

## API

Файл `versions.json` в корне репозитория содержит информацию о всех собранных версиях:

```json
{
  "lastUpdated": "2026-08-25T18:00:00.000Z",
  "versions": {
    "1.21.4": {
      "version": "1.21.4",
      "javaVersion": 21,
      "buildToolsVersion": "a1b2c3d",
      "size": 86543210,
      "filename": "spigot-1.21.4.jar",
      "timestamp": "2026-08-25T18:00:00.000Z",
      "releaseTag": "spigot-001.021.004",
      "downloadUrl": "https://github.com/MAINER4IK/spigot-versions-api/releases/download/spigot-001.021.004/spigot-1.21.4.jar"
    }
  }
}
```

### Доступ к JAR файлам

JAR файлы доступны через GitHub Releases:
```
https://github.com/MAINER4IK/spigot-versions-api/releases/download/{releaseTag}/spigot-{version}.jar
```

### Пример использования в лаунчере

```typescript
const response = await fetch('https://raw.githubusercontent.com/MAINER4IK/spigot-versions-api/main/versions.json');
const data = await response.json();

// Получить ссылку на JAR
const version = data.versions['1.21.4'];
const downloadUrl = version.downloadUrl;
```

## GitHub Actions

Workflow запускается раз в сутки и проверяет новые версии Spigot на SpigotMC.

### Ручной запуск

1. Перейдите в Actions → Build Spigot Versions
2. Нажмите "Run workflow"
3. Опция "Force rebuild" пересобирает все версии

### Автоматический запуск

- Cron: `0 3 * * *` (ежедневно в 03:00 UTC)
- Проверяет hub.spigotmc.org/versions/ на наличие новых версий
- Создаёт релиз для каждой доступной версии Spigot и заменяет JAR при изменении данных сборки.

## CraftBukkit (Bukkit)

Серверные JAR CraftBukkit собираются отдельным workflow `Build CraftBukkit Versions` из тех же версий BuildTools. Релизы имеют теги `bukkit-001.021.004` с числовой сортировкой, а имена файлов — `craftbukkit-1.21.4.jar`. Существующие релизы Spigot сохраняются отдельно.

Индекс CraftBukkit находится в `bukkit-versions.json` и содержит поле `downloadUrl` для каждой успешно опубликованной версии. Как и у Spigot, при изменении исходных данных JAR в существующем релизе обновляется. Workflow запускается раз в сутки и вручную через Actions.

```typescript
const response = await fetch('https://raw.githubusercontent.com/MAINER4IK/spigot-versions-api/main/bukkit-versions.json');
const data = await response.json();
const downloadUrl = data.versions['1.21.4'].downloadUrl;
```

Шесть старых сборок Spigot временно пропускаются автоматически из-за недоступных зависимостей BungeeCord. При изменении исходных данных Spigot проверка возобновится; ручной запуск с `Force rebuild` также позволяет повторить попытку.
