import ClientPeer from '../../base/ClientPeer';
import IHandler from './IHandler';
import FightCache from '../cache/fight/FightCache';
import Caches from '../cache/Caches';
import UserCache from '../cache/UserCache';
import OpCode from '../../protocol/code/OpCode';
import FightRoom from '../cache/fight/FIghtRoom';
import SocketMsg from '../../base/SocketMsg';
import CardDto from '../../protocol/dto/fight/CardDto';
import FightCode from '../../protocol/code/FightCode';
import GrabDto from '../../protocol/dto/GrabDto';
import DealDto from '../../protocol/dto/fight/DealDto';
import UserModel from '../model/UserModel';
import OverDto from '../../protocol/dto/fight/OverDto';

export default class FightHandler implements IHandler {
    private fightCache: FightCache = Caches.fight;
    private userCache: UserCache = Caches.user;
    public onDisconnect(client: ClientPeer) {
        console.log('client', client);
    }
    public onReceive(client: ClientPeer, subCode: number, value: any) {
        switch (subCode) {
            case FightCode.GRAB_LANDLORD_CREQ: // true: 抢地主 false:不抢
                let result: boolean = <boolean> value;
                this.grabLandlord(client, result);
                break;
            case FightCode.DEAL_CREQ:
                this.deal(client, <DealDto>value);
                break;
            case FightCode.PASS_CREQ:
                this.pass(client);
                break;
            default:
                break;
        }
    }
    public startFight(uidList: number[]) {
        let room: FightRoom = this.fightCache.create(uidList);
        room.initPlayerCards();
        room.sort();
        uidList.forEach((uid) => {
            let client = this.userCache.getClientPeer(uid);
            let cardList: CardDto[] = room.getUserCards(uid);
            client.send(OpCode.FIGHT, FightCode.GET_CARD_SRES, cardList);
        });
        let firstUserId = room.getFirstUid();
        this.brocast(room, OpCode.FIGHT, FightCode.TURN_GRAB_BRO, firstUserId, null);
    }
    /**
     * 广播
     * @param opCode
     * @param subCode
     * @param value
     * @param exClient
     */
    public brocast(room: FightRoom, opCode: number, subCode: number, value: any, exClient: ClientPeer = null) {
        let msg: SocketMsg = new SocketMsg(opCode, subCode, value);
        let client: ClientPeer = null;
        for (let pIndex in room.playerList) {
            if (room.playerList[pIndex]) {
                let player = room.playerList[pIndex];
                if (this.userCache.isOnline(player.userId)) {
                    client = this.userCache.getClientPeer(player.userId);
                    if (client === exClient) {
                        continue;
                    }
                    client.sendMsg(msg);
                }
            }
        }
    }
    /**
     * 抢地主处理
     * @param client
     * @param result
     */
    private grabLandlord(client: ClientPeer, result: boolean) {
        if (this.userCache.isOnline(client) === false) {
            // 不在线直接返回
            return;
        }
        let userId: number = this.userCache.getIdByClient(client);
        let room: FightRoom = this.fightCache.getRoomByUid(userId);
        if (result === true) {
            // 抢
            room.setLandlord(userId);
            let dto: GrabDto = new GrabDto(userId, room.tableCardList, room.getUserCards(userId));
            this.brocast(room, OpCode.FIGHT, FightCode.GRAB_LANDLORD_BRO, dto);
            // 发出一个出牌命令
            this.brocast(room, OpCode.FIGHT, FightCode.TURN_DEAL_BRO, userId);
        } else {
            // 不抢
            let nextUid: number = room.getNextUid(userId);
            this.brocast(room, OpCode.FIGHT, FightCode.TURN_GRAB_BRO, nextUid);
        }
    }
    /**
     * 出牌的处理
     * @param client
     * @param dealDto
     */
    private deal(client: ClientPeer, dealDto: DealDto) {
        if (this.userCache.isOnline(client) === false) {
            return;
        }
        let userId = this.userCache.getIdByClient(client);
        if (userId !== dealDto.userId) {
            return;
        }

        let room: FightRoom = this.fightCache.getRoomByUid(userId);
        // 玩家中途退出
        if (room.leaveUidList.indexOf(userId) === -1) {
            // 直接转换出牌
            this.turn(room);
        }
        // 玩家还在
        let canDeal: boolean = room.dealCard(dealDto.type, dealDto.weight, dealDto.length, dealDto.userId, dealDto.selectCardList);
        if (canDeal === false) {
            // 玩家的牌管不上上一玩家出的牌
            client.send(OpCode.FIGHT, FightCode.DEAL_SRES, 0x3001);
            return;
        } else {
            client.send(OpCode.FIGHT, FightCode.DEAL_SRES, 0);
            let remainCardList = room.getPlayerModel(userId).cardList;
            dealDto.remainCardList = remainCardList;
            this.brocast(room, OpCode.FIGHT, FightCode.DEAL_BRO, dealDto);
            // 检测下剩余的手牌，如果手牌为0，那就游戏结束了
            if (remainCardList.length === 0) {
                this.gameOver(userId, room);
            } else {
                this.turn(room);
            }
        }
    }
    /**
     * 转换出牌
     * @param room
     */
    private turn(room: FightRoom) {
        let nextUid = room.turn();
        if (room.isOffline(nextUid)) {
            // 如果下一个玩家掉线了，递归知道不掉线的玩家出牌为止
            this.turn(room);
        } else {
            this.brocast(room, OpCode.FIGHT, FightCode.TURN_DEAL_BRO, nextUid);
        }
    }
    /**
     * 游戏结束
     * @param userId
     * @param room
     */
    private gameOver(userId: number, room: FightRoom) {
        // 获取获胜的身份，所有玩家的id
        let winIdentity = room.getPlayerIdentity(userId);
        let winBeen = room.multiple * 1000;
        // 给胜利的玩家添加胜场
        let winUids = room.getSameIdentityUids(winIdentity);
        for (let i = 0, len = winUids.length; i < len; i++) {
            let um: UserModel = this.userCache.getModelById(winUids[i]);
            um.winCount++;
            um.been += winBeen;
            um.exp += 100;
            let maxExp = um.lv * 100;
            while (maxExp <= um.exp) {
                um.lv++;
                um.exp -= maxExp;
                maxExp = um.lv * 100;
            }
            this.userCache.update(um);
        }
        // 给失败的玩家添加负场
        let loseUids : number[] = room.getDifferentIdentityUids(winIdentity);
        for (let i = 0, len = loseUids.length; i < len; i++) {
            let um: UserModel = this.userCache.getModelById(loseUids[i]);
            um.loseCount++;
            um.been -= winBeen;
            um.exp += 10;
            let maxExp = um.lv * 100;
            while (maxExp <= um.exp) {
                um.lv++;
                um.exp -= maxExp;
                maxExp = um.loseCount * 100;
            }
            this.userCache.update(um);
        }
        // 给逃跑玩家添加逃跑场次
        for (let i = 0, len = room.leaveUidList.length; i < len; i++) {
            let um: UserModel = this.userCache.getModelById(room.leaveUidList[i]);
            um.runCount++;
            um.been -= (winBeen) * 3;
            um.been += 0;
            let maxExp = um.lv * 100;
            while (maxExp <= um.exp) {
                um.lv++;
                um.exp -= maxExp;
                maxExp = um.lv * 100;
            }
            this.userCache.update(um);
        }

        // 给客户端发送消息
        let dto: OverDto = new OverDto();
        dto.winIdentity = winIdentity;
        dto.winUidList = winUids;
        dto.beenCount = winBeen;
        this.brocast(room, OpCode.FIGHT, FightCode.OVER_BRO, dto);

        // 缓存层销毁房间数据
        this.fightCache.destroy(room);
    }
    /**
     * pass
     * @param client
     */
    private pass(client: ClientPeer) {
        if (this.userCache.isOnline(client) === false) {
            return;
        }
        let userId: number = this.userCache.getIdByClient(client);
        let room: FightRoom = this.fightCache.getRoomByUid(userId);
        if (room.roundModel.biggestUid === userId) {
            // 当前玩家是最大出牌者，没人管他，不能不出
            client.send(OpCode.FIGHT, FightCode.PASS_SRES, 0x3002);
            return;
        } else {
            // 可以不出
            client.send(OpCode.FIGHT, FightCode.PASS_SRES, 0);
            this.brocast(room, OpCode.FIGHT, FightCode.PASS_BRO, userId);
            this.turn(room);
        }
    }
}
