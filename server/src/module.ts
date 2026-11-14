import {Module} from '@nestjs/common';
import {JwtModule} from '@nestjs/jwt';
import {Db} from './db';
import {AuthController,AuthService,JwtGuard} from './auth';
import {MeetingsController,MeetingsService} from './meetings';
import {LiveGateway} from './live';

@Module({imports:[JwtModule.register({secret:process.env.JWT_SECRET||'UNSAFE_DEV_ONLY_CHANGE_ME',signOptions:{expiresIn:'7d'}})],controllers:[AuthController,MeetingsController],providers:[Db,AuthService,JwtGuard,MeetingsService,LiveGateway]})
export class AppModule {}
