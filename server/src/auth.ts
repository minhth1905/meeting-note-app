import {Injectable,Controller,Post,Body,UnauthorizedException,UseGuards,CanActivate,ExecutionContext,Req,Get} from '@nestjs/common';
import {JwtService} from '@nestjs/jwt';
import {IsEmail,IsString} from 'class-validator';
import {Db} from './db';
import bcrypt from 'bcryptjs';
import {Request} from 'express';
class LoginDto{@IsEmail() email!:string; @IsString() password!:string;}
@Injectable() export class AuthService{
 constructor(public db:Db,public jwt:JwtService){}
 async login(email:string,password:string){const u=await this.db.user.findUnique({where:{email}});if(!u||!(await bcrypt.compare(password,u.passwordHash)))throw new UnauthorizedException('Email hoặc mật khẩu không đúng');return {accessToken:this.jwt.sign({sub:u.id}),user:{id:u.id,name:u.name,email:u.email}};}
 getUser(token:string){try{return this.jwt.verify<{sub:string}>(token)}catch{return null}}
}
@Injectable() export class JwtGuard implements CanActivate{
 constructor(private auth:AuthService){}
 canActivate(ctx:ExecutionContext){const req=ctx.switchToHttp().getRequest<Request & {userId?:string}>();const token=req.headers.authorization?.replace(/^Bearer /i,'');const payload=token?this.auth.getUser(token):null;if(!payload)throw new UnauthorizedException();req.userId=payload.sub;return true;}
}
@Controller('auth')export class AuthController{constructor(private auth:AuthService){}@Post('login')login(@Body() b:LoginDto){return this.auth.login(b.email,b.password)}@UseGuards(JwtGuard)@Get('me')async me(@Req() req:Request&{userId:string}){const u=await this.auth.db.user.findUniqueOrThrow({where:{id:req.userId},select:{id:true,name:true,email:true}});return u;}}
