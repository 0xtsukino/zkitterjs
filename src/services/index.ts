import {GenericService} from "../utils/svc";
import Web3 from 'web3';
import { Contract } from 'web3-eth-contract';
import {AlreadyExistError, LevelDBAdapter} from "../adapters/leveldb";
import {UserService, UserServiceEvents} from "./users";
import {User} from "../models/user";
import {PubsubService} from "./pubsub";
import {PostService} from "./posts";
import {Connection, Message, MessageType, Moderation, Post, Profile} from "../utils/message";
import {ModerationService} from "./moderations";
import {ConnectionService} from "./connections";
import {UserMeta} from "../models/usermeta";
import {ProfileService} from "./profile";
import {GenericDBAdapterInterface} from "../adapters/db";
import {PostMeta} from "../models/postmeta";
import {ConstructorOptions} from "eventemitter2";
import {Proof} from "../models/proof";
import {GroupService} from "./groups";
import {GenericGroupAdapter} from "../adapters/group";
import {TazGroup} from "../adapters/groups/taz";
import {ZkIdentity} from "@zk-kit/identity";
import {InterepGroup} from "../adapters/groups/interep";
import {GlobalGroup} from "../adapters/groups/global";

export enum ZkitterEvents {
  ArbitrumSynced = 'Users.ArbitrumSynced',
  AlreadyExist = 'Level.AlreadyExist',
  NewMessageCreated = 'Zkitter.NewMessageCreated',
}

export class Zkitter extends GenericService {
  web3: Web3;

  registrar: Contract;

  db: GenericDBAdapterInterface;

  services: {
    users: UserService;
    pubsub: PubsubService;
    posts: PostService;
    moderations: ModerationService;
    connections: ConnectionService;
    profile: ProfileService;
    groups: GroupService;
  };

  static async initialize(options: {
    arbitrumHttpProvider: string;
    groups?: GenericGroupAdapter[];
    db?: GenericDBAdapterInterface;
    lazy?: boolean;
  }): Promise<Zkitter> {
    const db = options.db || await LevelDBAdapter.initialize();
    const users = new UserService({db, arbitrumHttpProvider: options.arbitrumHttpProvider});
    const posts = new PostService({db});
    const moderations = new ModerationService({db});
    const connections = new ConnectionService({db});
    const profile = new ProfileService({db});
    const groups = new GroupService({ db });
    const pubsub = await PubsubService.initialize(users, groups, options.lazy);

    const grouplist = options.groups || [
      new GlobalGroup({ db }),
      new TazGroup({ db }),
      new InterepGroup({ db, groupId: 'interrep_twitter_unrated' }),
      new InterepGroup({ db, groupId: 'interrep_twitter_bronze' }),
      new InterepGroup({ db, groupId: 'interrep_twitter_silver' }),
      new InterepGroup({ db, groupId: 'interrep_twitter_gold' }),
      new InterepGroup({ db, groupId: 'interrep_reddit_unrated' }),
      new InterepGroup({ db, groupId: 'interrep_reddit_bronze' }),
      new InterepGroup({ db, groupId: 'interrep_reddit_silver' }),
      new InterepGroup({ db, groupId: 'interrep_reddit_gold' }),
      new InterepGroup({ db, groupId: 'interrep_github_unrated' }),
      new InterepGroup({ db, groupId: 'interrep_github_bronze' }),
      new InterepGroup({ db, groupId: 'interrep_github_silver' }),
      new InterepGroup({ db, groupId: 'interrep_github_gold' }),
    ];

    for (const group of grouplist) {
      groups.addGroup(group);
    }

    return new Zkitter({ db, users, pubsub, posts, moderations, connections, profile, groups });
  }

  constructor(opts: ConstructorOptions & {
    db: GenericDBAdapterInterface;
    users: UserService;
    pubsub: PubsubService;
    posts: PostService;
    moderations: ModerationService;
    connections: ConnectionService;
    profile: ProfileService;
    groups: GroupService;
  }) {
    super(opts);
    this.db = opts.db;
    this.services = {
      pubsub: opts.pubsub,
      users: opts.users,
      posts: opts.posts,
      moderations: opts.moderations,
      connections: opts.connections,
      profile: opts.profile,
      groups: opts.groups,
    };

    for (const service of Object.values(this.services)) {
      service.onAny((event, value) => {
        this.emit(event, value);
      });
    }
  }

  async status() {
    return this.services.users.status();
  }

  async user(address: string) {
    const user = await this.services.users.getUser(address);

    if (!user) {
      return null;
    }

    return {
      ...user,
      subscribe: () => {
        return this.services.pubsub.subscribeUser(address, async (msg, proof) => {
          if (msg) {
            await this.insert(msg, proof);
          }
        });
      }
    };
  }


  async thread(hash: string) {
    const post = await this.services.posts.getPost(hash);

    if (!post) {
      return null;
    }

    return {
      ...post,
      subscribe: () => {
        return this.services.pubsub.subscribeThread(hash, async (msg, proof) => {
          if (msg) {
            await this.insert(msg, proof);
          }
        });
      }
    };
  }

  async syncUsers() {
    await this.services.users.fetchUsersFromArbitrum();
  }

  async syncGroup(groupId?: string) {
    await this.services.groups.sync(groupId);
  }

  async getGroupByRoot(rootHash: string) {
    return this.services.groups.getGroupByRoot(rootHash);
  }

  async getGroupMembers(groupId: string) {
    return this.services.groups.members(groupId);
  }

  async getMerklePath(idCommitment: string, groupId: string) {
    return this.services.groups.getMerklePath(idCommitment, groupId);
  }

  async getUsers(limit?: number, offset?: string|number): Promise<User[]> {
    return this.services.users.getUsers(limit, offset);
  }

  async getUser(address: string): Promise<User|null> {
    return this.services.users.getUser(address);
  }

  async getUserMeta(address: string): Promise<UserMeta> {
    return this.services.users.getUserMeta(address);
  }

  async getPosts(limit?: number, offset?: string|number): Promise<Post[]> {
    return this.services.posts.getPosts(limit, offset);
  }

  async getUserPosts(address: string, limit?: number, offset?: string|number): Promise<Post[]> {
    return this.services.posts.getUserPosts(address, limit, offset);
  }

  async getThread(hash: string, limit?: number, offset?: string|number): Promise<Post[]> {
    return this.services.posts.getReplies(hash, limit, offset);
  }

  async getPostMeta(hash: string): Promise<PostMeta> {
    return this.services.posts.getPostMeta(hash);
  }

  async getMessagesByUser(address: string, limit?: number, offset?: number|string) {
    return this.services.users.getMessagesByUser(address, limit, offset);
  }

  private async insert(msg: Message, proof: Proof) {
    try {
      switch (msg?.type) {
        case MessageType.Post:
          await this.services.posts.insert(msg as Post, proof);
          this.emit(ZkitterEvents.NewMessageCreated, msg);
          break;
        case MessageType.Moderation:
          await this.services.moderations.insert(msg as Moderation, proof);
          this.emit(ZkitterEvents.NewMessageCreated, msg);
          break;
        case MessageType.Connection:
          await this.services.connections.insert(msg as Connection, proof);
          this.emit(ZkitterEvents.NewMessageCreated, msg);
          break;
        case MessageType.Profile:
          await this.services.profile.insert(msg as Profile, proof);
          this.emit(ZkitterEvents.NewMessageCreated, msg);
          break;
      }
    } catch (e) {
      if (e === AlreadyExistError) {
        this.emit(ZkitterEvents.AlreadyExist, msg);
      }
    }
  }

  async queryUser(address: string) {
    return this.services.pubsub.queryUser(address, async (msg, proof) => {
      if (msg) {
        await this.insert(msg, proof);
      }
    });
  }

  async queryGroup(groupId: string) {
    return this.services.pubsub.queryGroup(groupId, async (msg, proof) => {
      if (msg) {
        await this.insert(msg, proof);
      }
    });
  }

  async queryAll() {
    return this.services.pubsub.queryAll(async (msg, proof) => {
      if (msg) {
        await this.insert(msg, proof);
      }
    });
  }

  async subscribe() {
    return this.services.pubsub.subscribeAll(async (msg, proof) => {
      if (msg) {
        await this.insert(msg, proof);
      }
    });
  }

  async subscribeUsers(addresses: string[]) {
    return this.services.pubsub.subscribeUsers(addresses, async (msg, proof) => {
      if (msg) {
        await this.insert(msg, proof);
      }
    });
  }

  async subscribeThreads(hashes: string[]) {
    return this.services.pubsub.subscribeThreads(hashes, async (msg, proof) => {
      if (msg) {
        await this.insert(msg, proof);
      }
    });
  }

  async getProof(hash: string): Promise<Proof|null> {
    return this.db.getProof(hash);
  }

  async watchArbitrum(interval?: number) {
    return this.services.users.watchArbitrum(interval);
  }

  async write(options: {
    creator: string;
    content: string;
    reference?: string;
    privateKey?: string,
    zkIdentity?: ZkIdentity,
    global?: boolean;
    groupId?: string;
  }) {
    return this.services.pubsub.write(options);
  }
}