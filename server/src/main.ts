import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './module';
import { json } from 'express';
async function bootstrap(){
  if(process.env.NODE_ENV==='production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length<24)) throw new Error('JWT_SECRET must be at least 24 chars in production');
  const app = await NestFactory.create(AppModule);
  app.enableCors({origin:(process.env.WEB_ORIGIN||'http://localhost:5173').split(','),credentials:true});
  app.use(json({limit:'2mb'}));
  app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
  await app.listen(Number(process.env.APP_PORT||3001),'0.0.0.0');
  console.log(`API listening on :${process.env.APP_PORT||3001}`);
}
bootstrap();
