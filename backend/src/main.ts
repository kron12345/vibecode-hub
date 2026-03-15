import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { SystemSettingsService } from './settings/system-settings.service';
import { createWinstonLogger } from './common/logger.config';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  const logger = createWinstonLogger();

  const app = await NestFactory.create(AppModule, { logger });
  const systemSettings = app.get(SystemSettingsService);

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      const allowed = systemSettings.corsOrigins;
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('VibCode Hub API')
    .setDescription('AI-Entwicklerteam-Portal API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, () =>
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  const port = process.env.PORT ?? 3100;
  await app.listen(port);
  logger.log(`VibCode Hub API running on port ${port}`);
}
bootstrap();
