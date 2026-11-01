#import <Foundation/Foundation.h>

typedef NS_ENUM(int32_t, RPAuthTagType) {
    RPAuthTagTypeZero = 0,
};

@interface CUPairingIdentity : NSObject
@property (nonatomic, copy) NSData *altIRK;
@end
