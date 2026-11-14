import {Injectable,OnModuleInit} from '@nestjs/common';
import {PrismaClient} from '@prisma/client';
import bcrypt from 'bcryptjs';
@Injectable()
export class Db extends PrismaClient implements OnModuleInit {
 async onModuleInit(){await this.$connect(); const email=process.env.DEMO_EMAIL;const password=process.env.DEMO_PASSWORD;
 if(email&&password){await this.user.upsert({where:{email},update:{},create:{email,name:'Administrator',passwordHash:await bcrypt.hash(password,12)}});}}
}
