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
      "timestamp": "2026-08-25T18:00:00.000Z"
    }
  }
}
```

### Доступ к JAR файлам

JAR файлы доступны через GitHub Releases:
```
https://github.com/MAINER4IK/spigot-versions-api/releases/download/spigot-{version}/spigot-{version}.jar
```

### Пример использования в лаунчере

```typescript
const response = await fetch('https://github.com/MAINER4IK/spigot-versions-api/main/versions.json');
const data = await response.json();

// Получить ссылку на JAR
const version = data.versions['1.21.4'];
const downloadUrl = `https://github.com/MAINER4IK/spigot-versions-api/releases/download/spigot-${version.version}/${version.filename}`;
```

## GitHub Actions

Workflow запускается каждые 6 часов и проверяет новые версии Spigot на SpigotMC.

### Ручной запуск

1. Перейдите в Actions → Build Spigot Versions
2. Нажмите "Run workflow"
3. Опция "Force rebuild" пересобирает все версии

### Автоматический запуск

- Cron: `0 */6 * * *` (каждые 6 часов)
- Проверяет hub.spigotmc.org/versions/ на наличие новых версий
- Собирает только новые версии (кэширование в versions.json)
