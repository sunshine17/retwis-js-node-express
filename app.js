
/**
 * Module dependencies.
 */
require.paths.push(__dirname);
require.paths.push(__dirname+"/lib");
require.paths.push(__dirname+"/lib/node_redis");

var express = require('express');
var redis = require('index');
var uuid = require('node-uuid');

var app = module.exports = express.createServer();

// Configuration

app.configure(function(){
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.use(express.bodyParser());
  app.use(express.cookieParser());
  app.use(express.methodOverride());
  app.use(app.router);
  app.use(express.static(__dirname + '/public'));
});

app.configure('development', function(){
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true })); 
});

app.configure('production', function(){
  app.use(express.errorHandler()); 
});

// Handlers
function main(req, res) {
    return get_current_user(req, res, main_callback);

    function main_callback(req, res, user) {
        if ( !user ) {
            return res.render('welcome', {title:'welcome'})
        }
        else {
            // range
            var start = get_argument(req, 'start', 0);
            var count = get_argument(req, 'count', 10);

            // followers/following
            var followers = 0;
            var following = 0;

            // posts
            var client = get_client();
            client.lrange("retwis:uid:"+ user.user_id + ":posts", start, (start+count), function(err, reply) {
                    var posts = reply;
                    return load_posts(req, res, posts, function(req, res, posts) {
                        return res.render('home', {
                            title: 'home',
                            user: user,
                            posts: posts,
                            followers: followers,
                            following: following
                        }); //res.render
                    }); //load_posts
               }); // client.lrange
        } // else
    }; //main_callback
};

function post(req, res) {
    return get_current_user(req, res, post_callback);

    function post_callback(req, res, user) {
        if ( !user ) {
            return res.redirect('/home');
        }
        var post_status = get_argument(req, 'status', "").replace("\n","");
        if ( post_status.length == 0 ) {
            return do_error(res, "empty status");
        }
        var client = get_client();
        client.incr("retwis:global:nextPostId", function(err, reply) {
            var post_id = reply;
            var post = user.user_id + "|" + (new Date()).getTime() + "|" + post_status;
            client.set("retwis:post:" + post_id, post, function(err, reply) {
                // get all followers
                client.smembers("retwis:uid:" + user.user_id + ":follwers", function(err, reply) {
                    var followers = reply;
                    if ( !followers ) {
                        followers = [];
                    }
                    followers.push(user.user_id);
                    var multi = client.multi();
                    // push the post to all followers
                    for (var fid in followers) {
                        multi.lpush("retwis:uid:"+followers[fid]+":posts", post_id);
                    }
                    // push the post to the timeline and trim the timeline to 1000 elements
                    multi.lpush("retwis:global:timeline", post_id);
                    multi.ltrim("retwis:global:timeline", 0, 1000);
                    multi.exec(function(err, replies) {
                        // refresh the page
                        client.end();
                        res.redirect('/home');
                        }); //multi.exec
                    }); // client.smembers
            }); // client.set
        }); //client.incr

    }; //post_callback

};

function login(req, res) {
    var current_user;
    //TODO: get_current_user
    if ( ! current_user ) {
        var username = req.body.username;
        var password = req.body.password;
        if ( !username || !password ) {
            return do_error(res, "You must enter a username and password to login.");
        }
        var client = get_client();
        client.get("retwis:username:"+username+":id", function(err, reply) {
            var user_id = reply;
            if ( !user_id ) {
                client.end();
                return do_error(res, "Username not found.");
            }
            client.get("retwis:uid:"+user_id+":password", function(err, reply) {
                var redis_pass = reply;
                if ( password != redis_pass ) {
                    client.end();
                    return do_error(res, "Wrong username or password.");
                }
                return save_auth_token(req, res, client, user_id, client, function(req, res, client) {
                    client.end();
                    return res.redirect("/home");
                });
            });
        });
    }
    else {
        return res.redirect("/home");
    }
};

function logout(req, res) {
    res.clearCookie("auth");
    res.redirect('/home');
};

function profile(req, res) {
    return get_current_user(req, res, profile_callback);

    function profile_callback(req, res, user) {
        if ( !user ) {
            return res.redirect('/home');
        }
        var member_name = get_argument(req, "u", undefined);
        if ( member_name == undefined ) {
            console.log("no member name passed.");
            return do_error(res, "User not found.");
        }
        var client = get_client();
        client.get("retwis:username:" + member_name + ":id", function(err, reply) {
            var member_id = reply;
            if ( !member_id ) {
                console.log("member not found in datastore");
                return do_error(res, "User not found.");
            }
            client.sismember("retwis:uid:"+user.user_id+":following", member_id, function(err, reply) {
                var is_following = reply;
                console.log(user.username + " following " + member_name + " ? " + is_following);

                client.lrange("retwis:uid:" + member_id + ":posts", 0, 10, function(err, reply) {
                    var posts = reply;
                    client.end();
                    return load_posts(req, res, posts, function(req, res, posts) {
                        res.render('profile', {
                            title: 'profile',
                            user: user,
                            posts: posts,
                            is_following: is_following,
                            member_name: member_name,
                            member_id: member_id
                        }); //res.render
                    }); // load_posts
                }); // client.lrange
            }); // client.sismember
        }); // client.get
        return;
    };
};

var follow = function(req, res) {
  res.render('index', {
title: 'post'
});
};

function register(req, res) {
    return get_current_user(req, res, regster_callback);

    function regster_callback(req, res, user) {
        if (user) {
            return res.redirect("/home");
        }
        else {
            username = req.body.username;
            password = req.body.password;
            passconf = req.body.passconf;
            if ( !username || !password ) {
                do_error(res, "You must enter a username and password to register.");
                return;
            }
            if ( password != passconf ) {
                do_error(res, "Your password does not match.");
                return;
            }
            // check if username is available


            // register the user
            var client = get_client();
            client.incr("retwis:global:nextUserId", function(err, reply) {
                    user_id = reply;
                    client.multi()
                    .set("retwis:uid:"+user_id+":username", username)
                    .set("retwis:uid:"+user_id+":password", password)
                    .set("retwis:username:"+username+":id", user_id)
                    .sadd("retwis:global:users", user_id)
                    .exec(function(err, replies) {

                        return save_auth_token(req, res, client, user_id, { client: client, username: username }, function(req, res, args) {
                            client = args.client;
                            username = args.username;
                            client.end();
                            return res.render('register', {
                                title: 'register',
                                username: username
                                });
                            });
                        });
                    });
        }
    }
};

function timeline(req, res) {
    var client = get_client();
    client.sort("retwis:global:users", 0, 10, 
    //FIXME:
};

function do_error(res, msg) {
    console.log(msg);
    res.render('error', {
        title: 'error',
        message: msg
        });
    return;
}
function get_client() {
  return redis.createClient();
};

function get_current_user(req, res, callback) {
    var user;
    var auth_cookie = req.cookies.auth;
    if ( !auth_cookie) {
        console.log("no auth cookie; user not log in");
        return callback(req, res, user);
    }
    var client = get_client();
    client.get("retwis:auth:" + auth_cookie, function(err, reply) {
        var user_id = reply;

        if ( !user_id ) {
          console.log("No user_id for cookie found in redis ");
          client.end();
          return callback(req, res, user);
        }

        client.get("retwis:uid:" + user_id + ":username", function(err, reply) {
            username = reply;
            client.end();
            user = { user_id: user_id, username: username};
            return callback(req, res, user);
            });
    });
};

function save_auth_token(req, res, client, user_id, args_for_callback, callback) {
    var auth_uid = uuid();
    client.multi()
        .set("retwis:uid:"+user_id+":auth", auth_uid)
        .set("retwis:auth:"+auth_uid, user_id)
        .exec(function(err, replies) {
                res.cookie('auth', auth_uid, {maxAge: 100000});
                return callback(req, res, args_for_callback);
        });
    return;

};

function get_argument(req, property, default_value) {
    if (req.query != undefined && req.query[property] != undefined) {
        return req.query[property];
    }
    if (req.body != undefined && req.body[property] != undefined) {
        return req.body[property];
    }
    return default_value;
};

function load_posts(req, res, posts, callback) {
    var client = get_client();
    var multi = client.multi();
    for (var pid in posts) {
        multi.get("retwis:post:"+posts[pid]);
    }
    multi.exec(function(err, replies) {
        var posts = [];
        var post_datas = replies;
        var multi = client.multi();
        for (var pid in post_datas) {
            var post_data = post_datas[pid];
            var post_list = post_data.split("|", 3);
            var elapsed = get_elapsed(post_list[1]);
            var data = post_list[2];
            var user_id = post_list[0];
            posts.push({ post: data, elapsed: elapsed, user_id: user_id});
            multi.get("retwis:uid:"+user_id+":username");
        }
        multi.exec(function(err, replies) {
            var usernames = replies;
            for (uid in usernames) {
                var username = usernames[uid];
                posts[uid].username = username;
            }
            client.end();
            return callback(req, res, posts);
        }); // multi.exec
    }); // multi.exec
}; //load_posts

function get_elapsed(t) {
    var diff = (new Date()).getTime() - parseInt(t, 10);
    diff = parseInt(diff/1000);
    if (diff < 60) {
        return diff + ( diff>1 ? " seconds" : " second");
    }
    if (diff < 3600) {
        diff = parseInt(diff/60);
        return diff + ( diff>1 ? " minutes" : " minute");
    }
    if (diff < 3600*24) {
        diff = parseInt(diff/3600);
        return diff + ( diff>1 ? " hours" : " hour");
    }
    diff = parseInt(diff/(3600*24));
    return diff + ( diff>1 ? " days" : " day");
};
// Routes
app.get('/', main);
app.get('/home', main);
app.post('/post', post);
app.post('/login', login);
app.get('/logout', logout);
app.get('/profile', profile);
app.get('/follow', follow);
app.post('/register', register);
app.get('/timeline', timeline);


// Only listen on $ node app.js

if (!module.parent) {
  app.listen(3000);
  console.log("Express server listening on port %d", app.address().port);
}
